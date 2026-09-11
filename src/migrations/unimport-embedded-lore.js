import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite, getCharacterCardJson, getCharactersWithLinkedWorld, isMigrationMarkedComplete, markMigrationComplete, isBootstrapComplete } from '../character-metadata-db.js';

/**
 * One-time reversal for characters auto-linked to a World file by the old importEmbeddedWorldInfo()
 * flow, from before embedded character_book could be activated directly and before
 * charUpdatePrimaryWorld() stopped deleting character_book on unlink.
 *
 * A World only qualifies if it carries `originalData` (set by convertCharacterBook() and persisted
 * verbatim by every path that saves an auto-imported book to a World file) - a structural marker that
 * a World was born from an embedded book, never set on a hand-created/hand-picked World.
 *
 * `originalData` doesn't prove the currently-linked character is the original source, or that nothing
 * has diverged since (deliberate sharing, edits to either copy, or a since-deleted character_book are
 * all possible). Only acts when unambiguous: exactly one linker, and either the character's
 * character_book content-matches `originalData` (unlink only) or the character has no character_book at
 * all (restore from `originalData` and unlink). Anything else is left untouched and reported.
 *
 * Never deletes/renames the World file itself - it may still be referenced elsewhere this migration
 * can't reliably enumerate. `run()` just reports orphaned worlds for manual cleanup.
 *
 * findCandidates() never walks the full character corpus - it starts from
 * getCharactersWithLinkedWorld() (indexed `WHERE world IS NOT NULL`) and only opens a character PNG per
 * remaining candidate. An earlier full-corpus-read version OOM-crashed on this repo's own character
 * library; this design replaced it.
 *
 * runOnceAtBoot() (called by server-main.js, unawaited, after initializeMetadataStores()) runs at most
 * once per user, gated on isMigrationMarkedComplete()/markMigrationComplete(). It waits for
 * isBootstrapComplete() before trusting getCharactersWithLinkedWorld(), since that index isn't
 * populated until the metadata backfill finishes; on timeout it retries next boot without marking done.
 *
 * `run()`/`findCandidates()` also work as a manual CLI: `node src/migrations/unimport-embedded-lore.js
 * [--handle X] [--apply]` (defaults to dry run).
 */

/** Recursively sorts object keys so structurally-equal values serialize identically. */
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = canonicalize(value[key]);
            return acc;
        }, {});
    }
    return value;
}

/** Compares only `entries` (order-insensitive) - top-level book metadata drift shouldn't block an unlink. */
function characterBookEntriesMatch(characterBook, originalData) {
    if (!characterBook || !originalData) return false;
    return JSON.stringify(canonicalize(characterBook.entries ?? [])) === JSON.stringify(canonicalize(originalData.entries ?? []));
}

/** Works out, without mutating anything, which characters are safe to unimport vs. ambiguous. See module header. */
export async function findCandidates(directories, log) {
    const linked = await getCharactersWithLinkedWorld(directories);
    if (linked === null) {
        throw new Error('Character metadata store is unavailable on this install (no usable SQLite backend) - cannot find candidates without an indexed lookup, and this migration deliberately refuses to fall back to a full-corpus scan to get one. Aborting.');
    }

    /** @type {Map<string, string[]>} worldName -> avatars currently linking to it as their primary world */
    const linkersByWorld = new Map();
    for (const { id: avatar, world: worldName } of linked) {
        const list = linkersByWorld.get(worldName) ?? [];
        list.push(avatar);
        linkersByWorld.set(worldName, list);
    }

    /** @type {Map<string, object|null>} worldName -> parsed World file (null if missing/unreadable) */
    const worldCache = new Map();
    const loadWorld = (worldName) => {
        if (worldCache.has(worldName)) return worldCache.get(worldName);
        let world = null;
        try {
            world = readWorldInfoFile(directories, worldName, false);
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] Failed to read World "${worldName}": ${err.message}`));
        }
        worldCache.set(worldName, world);
        return world;
    };

    const safe = [];
    const ambiguous = [];

    for (const { id: avatar, world: worldName } of linked) {
        const world = loadWorld(worldName);
        const hasOriginalDataMarker = !!(world && world.originalData && Array.isArray(world.originalData.entries));
        if (!hasOriginalDataMarker) continue;

        const linkers = linkersByWorld.get(worldName) ?? [];
        if (linkers.length > 1) {
            ambiguous.push({ avatar, worldName, reason: `World is currently linked by ${linkers.length} characters (${linkers.join(', ')}) - treated as deliberate sharing, not touched` });
            continue;
        }

        let card;
        try {
            // Prefer the metadata db's parked copy over the PNG - classifying against stale content
            // would misjudge a card the user already edited.
            const rawJson = await getCharacterCardJson(directories, avatar)
                ?? await parseCharacterCard(path.join(directories.characters, avatar), 'png');
            card = getCharaCardV2(JSON.parse(rawJson), directories, false);
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] Failed to read candidate ${avatar}, skipping: ${err.message}`));
            continue;
        }

        // Metadata row can lag a live edit.
        if (card?.data?.extensions?.world !== worldName) continue;

        const characterBook = card?.data?.character_book;
        if (!characterBook) {
            safe.push({ avatar, worldName, action: 'restore-and-unlink' });
            continue;
        }

        if (characterBookEntriesMatch(characterBook, world.originalData)) {
            safe.push({ avatar, worldName, action: 'unlink-only' });
            continue;
        }

        ambiguous.push({ avatar, worldName, reason: 'Character has its own embedded lorebook that no longer matches the linked World\'s original import snapshot - cannot tell which version to keep' });
    }

    return { safe, ambiguous };
}

/** Unlinks `extensions.world`, restoring `character_book` from `originalData` first if missing. Never touches the World file. */
async function unimportOne(directories, candidate, log) {
    const { avatar, worldName, action } = candidate;
    const avatarPath = path.join(directories.characters, avatar);

    try {
        const parked = await getCharacterCardJson(directories, avatar);
        const rawJson = parked ?? await parseCharacterCard(avatarPath, 'png');
        const card = getCharaCardV2(JSON.parse(rawJson), directories, false);

        if (card?.data?.extensions?.world !== worldName) {
            log(color.yellow(`[unimport-embedded-lore] ${avatar} no longer links to "${worldName}" (changed since candidates were computed) - skipping.`));
            return false;
        }

        if (action === 'restore-and-unlink') {
            const world = readWorldInfoFile(directories, worldName, false);
            if (!world?.originalData?.entries) {
                log(color.red(`[unimport-embedded-lore] ${avatar}: World "${worldName}" no longer has a restorable originalData snapshot - skipping.`));
                return false;
            }
            card.data.character_book = world.originalData;
        }

        card.data.extensions.world = undefined;

        const updated = JSON.stringify(card);
        if (parked !== null) {
            // Card lives in the db - don't rewrite the PNG (would retire the parked copy via the
            // default upsert). Keep the row's mtime as the file's current one, or the watcher reads
            // this as external drift and rolls the card back to the stale chunk.
            const stat = await fsPromises.stat(avatarPath);
            await upsertCharacterFromWrite(directories, avatar, updated, stat.mtimeMs, null, null);
        } else {
            await writeCardToFile(avatarPath, avatarPath, updated);
            // Stat after the write - stat'ing before records the pre-write mtime, which permanently
            // disagrees with disk and flags this row as externally modified on every later pass.
            const stat = await fsPromises.stat(avatarPath);
            await upsertCharacterFromWrite(directories, avatar, updated, stat.mtimeMs);
        }

        log(color.green(`[unimport-embedded-lore] ${avatar}: unlinked from "${worldName}"${action === 'restore-and-unlink' ? ' and restored its embedded lorebook' : ''}.`));
        return true;
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to unimport ${avatar}: ${err.message}`));
        return false;
    }
}

/** Runs the full unimport pass for one user. Dry run by default - pass `{ apply: true }` to actually write. */
export async function run(directories, options = {}) {
    const log = options.log ?? console.log;
    const apply = options.apply === true;

    const { safe, ambiguous } = await findCandidates(directories, log);

    log(`[unimport-embedded-lore] ${safe.length} character(s) safe to unimport, ${ambiguous.length} ambiguous (left untouched).`);
    for (const { avatar, worldName, reason } of ambiguous) {
        log(color.yellow(`[unimport-embedded-lore] AMBIGUOUS, not touched: ${avatar} (linked to "${worldName}") - ${reason}`));
    }

    let migrated = 0;
    let failed = 0;

    if (!apply) {
        for (const { avatar, worldName, action } of safe) {
            log(color.cyan(`[unimport-embedded-lore] DRY RUN would ${action === 'restore-and-unlink' ? 'restore character_book and unlink' : 'unlink'}: ${avatar} from "${worldName}"`));
        }
    } else {
        for (const candidate of safe) {
            const ok = await unimportOne(directories, candidate, log);
            if (ok) migrated++; else failed++;
        }
    }

    // Worlds carrying the originalData marker with no primary linker left, for manual review.
    const stillLinkedRows = await getCharactersWithLinkedWorld(directories);
    const stillLinked = new Set((stillLinkedRows ?? []).map(r => r.world).filter(Boolean));
    const orphanedWorlds = [];
    if (fs.existsSync(directories.worlds)) {
        const worldFiles = (await fsPromises.readdir(directories.worlds)).filter(f => f.endsWith('.json'));
        for (const file of worldFiles) {
            const name = path.parse(file).name;
            if (stillLinked.has(name)) continue;
            const world = readWorldInfoFile(directories, name, false);
            if (world?.originalData?.entries) {
                orphanedWorlds.push(name);
            }
        }
    }
    if (orphanedWorlds.length > 0) {
        log(color.cyan(`[unimport-embedded-lore] ${orphanedWorlds.length} World file(s) came from an embedded-lore import and now have no character linking to them - left in place, review/delete manually if wanted: ${orphanedWorlds.join(', ')}`));
    }

    log(color.green(`[unimport-embedded-lore] Done${apply ? '' : ' (dry run, nothing written - pass --apply to write)'}: ${migrated}/${safe.length} unimported, ${failed} failed, ${ambiguous.length} left ambiguous.`));
    return { safe: safe.length, migrated, failed, ambiguous, orphanedWorlds };
}

const BOOT_MIGRATION_KEY = 'unimport_embedded_lore_completed';
// Generous: a library large enough for this migration to matter can still have its bootstrap backfill
// running well after the server started listening.
const BOOTSTRAP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOTSTRAP_POLL_INTERVAL_MS = 5000;

/**
 * Auto-run entry point (server-main.js calls this, unawaited, after initializeMetadataStores()).
 * Runs at most once per user, gated on isMigrationMarkedComplete(). Waits for isBootstrapComplete()
 * before trusting getCharactersWithLinkedWorld(), since that index isn't populated until the metadata
 * backfill finishes; on timeout it returns without marking complete, so the next boot retries.
 * @param {number} [options.bootstrapWaitTimeoutMs] Test hook only.
 * @param {number} [options.bootstrapPollIntervalMs] Test hook only.
 */
export async function runOnceAtBoot(directories, options = {}) {
    const log = options.log ?? console.log;
    const waitTimeoutMs = options.bootstrapWaitTimeoutMs ?? BOOTSTRAP_WAIT_TIMEOUT_MS;
    const pollIntervalMs = options.bootstrapPollIntervalMs ?? BOOTSTRAP_POLL_INTERVAL_MS;

    if (await isMigrationMarkedComplete(directories, BOOT_MIGRATION_KEY)) {
        return { status: 'already-complete' };
    }

    const deadline = Date.now() + waitTimeoutMs;
    while (!(await isBootstrapComplete(directories))) {
        if (Date.now() > deadline) {
            log(color.yellow(`[unimport-embedded-lore] (${directories.root}) Metadata bootstrap still not complete after ${Math.round(waitTimeoutMs / 60000)} minutes - giving up for this boot, will retry next boot.`));
            return { status: 'bootstrap-timeout' };
        }
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    let result;
    try {
        log(color.cyan(`[unimport-embedded-lore] (${directories.root}) Running one-time boot migration...`));
        result = await run(directories, { apply: true, log });
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] (${directories.root}) Boot migration run failed, will retry next boot: ${err.message}`));
        return { status: 'error' };
    }

    // Marks complete even with per-character failures inside result - those are things like a corrupt
    // PNG that would fail identically on retry; can still be retried manually via the CLI path below.
    await markMigrationComplete(directories, BOOT_MIGRATION_KEY);
    return { status: 'ran', result };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const { initConfig } = await import('../config-init.js');
    const { getUserDirectories, getAllUserHandles } = await import('../users.js');

    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };

    const dataRoot = getArg('data-root', './data');
    const handleArg = getArg('handle', null);
    const configPath = getArg('config', './config.yaml');
    const apply = args.includes('--apply');

    globalThis.DATA_ROOT = dataRoot;
    initConfig(configPath);

    const handles = handleArg ? [handleArg] : await getAllUserHandles();
    console.log(color.cyan(`[unimport-embedded-lore] Running for handle(s): ${handles.join(', ')} under data root "${dataRoot}"${apply ? '' : ' (dry run)'}...`));

    let anyFailed = false;
    for (const handle of handles) {
        const directories = getUserDirectories(handle);
        console.log(color.cyan(`[unimport-embedded-lore] --- ${handle} ---`));
        try {
            const result = await run(directories, { apply });
            if (result.failed > 0) anyFailed = true;
        } catch (err) {
            console.error(color.red(`[unimport-embedded-lore] Run failed for handle "${handle}":`), err);
            anyFailed = true;
        }
    }

    if (anyFailed) {
        process.exitCode = 1;
    }
}
