import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite, getCharacterCardJson, streamLinkedWorlds, streamCharactersLinkedToWorld, isWorldLinkedByAnyCharacter, isMigrationMarkedComplete, markMigrationComplete, isBootstrapComplete } from '../character-metadata-db.js';

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
 * findCandidates() never walks the full character corpus - it starts from streamLinkedWorlds() (indexed
 * on `world`) and only opens a character PNG per remaining candidate. An earlier full-corpus-read version
 * OOM-crashed on this repo's own character library; this design replaced it. Nothing is gathered up front
 * either: run() handles each world as soon as it is classified, a page of worlds at a time, with no
 * database read open while it writes.
 *
 * runOnceAtBoot() (called by server-main.js, unawaited, after initializeMetadataStores()) runs at most
 * once per user, gated on isMigrationMarkedComplete()/markMigrationComplete(). It waits for
 * isBootstrapComplete() before trusting streamLinkedWorlds(), since that index isn't
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

const STORE_UNAVAILABLE_MESSAGE = 'Character metadata store is unavailable on this install (no usable SQLite backend) - cannot find candidates without an indexed lookup, and this migration deliberately refuses to fall back to a full-corpus scan to get one. Aborting.';

/**
 * @typedef {{ avatar: string, worldName: string, action: 'restore-and-unlink' | 'unlink-only' }} SafeCandidate
 * @typedef {{ avatar: string, worldName: string, reason: string }} AmbiguousCandidate
 * @typedef {{ safe: SafeCandidate[], ambiguous: AmbiguousCandidate[] }} Findings
 */

/** Classifies the only character linking a World that carries the originalData marker. */
async function classifySoleLinker(directories, avatar, worldName, world, log) {
    let card;
    try {
        // Prefer the metadata db's parked copy over the PNG - classifying against stale content
        // would misjudge a card the user already edited.
        const rawJson = await getCharacterCardJson(directories, avatar)
            ?? await parseCharacterCard(path.join(directories.characters, avatar), 'png');
        card = getCharaCardV2(JSON.parse(rawJson), directories, false);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to read candidate ${avatar}, skipping: ${err.message}`));
        return null;
    }

    // Metadata row can lag a live edit.
    if (card?.data?.extensions?.world !== worldName) return null;

    const characterBook = card?.data?.character_book;
    if (!characterBook) {
        return { safe: [{ avatar, worldName, action: 'restore-and-unlink' }], ambiguous: [] };
    }

    if (characterBookEntriesMatch(characterBook, world.originalData)) {
        return { safe: [{ avatar, worldName, action: 'unlink-only' }], ambiguous: [] };
    }

    return { safe: [], ambiguous: [{ avatar, worldName, reason: 'Character has its own embedded lorebook that no longer matches the linked World\'s original import snapshot - cannot tell which version to keep' }] };
}

/**
 * One linked World's findings: nothing unless the World carries the originalData marker; then its sole linker
 * classified, or every linker of a shared World as ambiguous, one page of linkers per yield.
 * @returns {AsyncGenerator<Findings, void, undefined>}
 */
async function* classifyWorld(directories, worldName, linkers, log) {
    let world = null;
    try {
        world = readWorldInfoFile(directories, worldName, false);
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to read World "${worldName}": ${err.message}`));
    }
    const hasOriginalDataMarker = !!(world && world.originalData && Array.isArray(world.originalData.entries));
    if (!hasOriginalDataMarker) return;

    const linkerPages = await streamCharactersLinkedToWorld(directories, worldName);
    if (linkerPages === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }

    // Shared once the world list or this World's own linkers show more than one; a World that became shared
    // since the world list was read is never treated as a sole link.
    let sharedBy = linkers > 1 ? linkers : 0;
    for await (const avatars of linkerPages) {
        if (!sharedBy && avatars.length > 1) {
            sharedBy = avatars.length;
        }
        if (!sharedBy) {
            const findings = await classifySoleLinker(directories, avatars[0], worldName, world, log);
            if (findings) yield findings;
            continue;
        }
        const reason = `World is currently linked by ${sharedBy} characters - treated as deliberate sharing, not touched`;
        yield { safe: [], ambiguous: avatars.map(avatar => ({ avatar, worldName, reason })) };
    }
}

/**
 * Works out, without mutating anything, which characters are safe to unimport vs. ambiguous (see module header),
 * one World at a time. Holds at most one page of the world list and one page of a World's linkers, and no database
 * read is open while the consumer holds a yield, so it may write before asking for the next.
 * @returns {AsyncGenerator<Findings, void, undefined>}
 */
export async function* findCandidates(directories, log) {
    const linkedWorlds = await streamLinkedWorlds(directories);
    if (linkedWorlds === null) {
        throw new Error(STORE_UNAVAILABLE_MESSAGE);
    }

    for await (const worlds of linkedWorlds) {
        for (const { world: worldName, linkers } of worlds) {
            yield* classifyWorld(directories, worldName, Number(linkers), log);
            // Each World is a synchronous file read on the main thread; let requests in between.
            await new Promise(resolve => setImmediate(resolve));
        }
    }
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
            // default upsert).
            await upsertCharacterFromWrite(directories, avatar, updated, null, null);
        } else {
            await writeCardToFile(avatarPath, avatarPath, updated);
            await upsertCharacterFromWrite(directories, avatar, updated);
        }

        log(color.green(`[unimport-embedded-lore] ${avatar}: unlinked from "${worldName}"${action === 'restore-and-unlink' ? ' and restored its embedded lorebook' : ''}.`));
        return true;
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to unimport ${avatar}: ${err.message}`));
        return false;
    }
}

const ORPHANED_WORLDS_PER_LINE = 100;

/**
 * Logs the Worlds carrying the originalData marker that no character links as its primary world any more, for
 * manual review, at most ORPHANED_WORLDS_PER_LINE names per line. Streams the worlds folder and asks the index
 * about one World at a time, so neither the folder listing nor the linked Worlds are ever held.
 * @returns {Promise<number>} how many there were
 */
async function reportOrphanedWorlds(directories, log) {
    if (!fs.existsSync(directories.worlds)) return 0;

    let count = 0;
    /** @type {string[]} */
    let names = [];
    const flush = () => {
        if (names.length === 0) return;
        log(color.cyan(`[unimport-embedded-lore] ${names.length} World file(s) came from an embedded-lore import and now have no character linking to them - left in place, review/delete manually if wanted: ${names.join(', ')}`));
        names = [];
    };

    for await (const dirent of await fsPromises.opendir(directories.worlds)) {
        if (!dirent.name.endsWith('.json')) continue;
        const name = path.parse(dirent.name).name;
        const linked = await isWorldLinkedByAnyCharacter(directories, name);
        if (linked === null) {
            throw new Error(STORE_UNAVAILABLE_MESSAGE);
        }
        if (linked) continue;
        const world = readWorldInfoFile(directories, name, false);
        if (world?.originalData?.entries) {
            names.push(name);
            count++;
            if (names.length >= ORPHANED_WORLDS_PER_LINE) flush();
        }
        // Each World is a synchronous file read on the main thread; let requests in between.
        await new Promise(resolve => setImmediate(resolve));
    }
    flush();
    return count;
}

/**
 * Runs the full unimport pass for one user. Dry run by default - pass `{ apply: true }` to actually write.
 * @returns {Promise<{ safe: number, migrated: number, failed: number, ambiguous: number, orphanedWorlds: number }>} counts
 */
export async function run(directories, options = {}) {
    const log = options.log ?? console.log;
    const apply = options.apply === true;

    let safe = 0;
    let ambiguous = 0;
    let migrated = 0;
    let failed = 0;

    for await (const findings of findCandidates(directories, log)) {
        for (const { avatar, worldName, reason } of findings.ambiguous) {
            log(color.yellow(`[unimport-embedded-lore] AMBIGUOUS, not touched: ${avatar} (linked to "${worldName}") - ${reason}`));
        }
        ambiguous += findings.ambiguous.length;
        safe += findings.safe.length;

        for (const candidate of findings.safe) {
            if (!apply) {
                const { avatar, worldName, action } = candidate;
                log(color.cyan(`[unimport-embedded-lore] DRY RUN would ${action === 'restore-and-unlink' ? 'restore character_book and unlink' : 'unlink'}: ${avatar} from "${worldName}"`));
                continue;
            }
            const ok = await unimportOne(directories, candidate, log);
            if (ok) migrated++; else failed++;
        }
    }

    const orphanedWorlds = await reportOrphanedWorlds(directories, log);

    log(color.green(`[unimport-embedded-lore] Done${apply ? '' : ' (dry run, nothing written - pass --apply to write)'}: ${migrated}/${safe} unimported, ${failed} failed, ${ambiguous} left ambiguous.`));
    return { safe, migrated, failed, ambiguous, orphanedWorlds };
}

const BOOT_MIGRATION_KEY = 'unimport_embedded_lore_completed';
// Generous: a library large enough for this migration to matter can still have its bootstrap backfill
// running well after the server started listening.
const BOOTSTRAP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOTSTRAP_POLL_INTERVAL_MS = 5000;

/**
 * Auto-run entry point (server-main.js calls this, unawaited, after initializeMetadataStores()).
 * Runs at most once per user, gated on isMigrationMarkedComplete(). Waits for isBootstrapComplete()
 * before trusting streamLinkedWorlds(), since that index isn't populated until the metadata
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
