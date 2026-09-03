import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite, getCharactersWithLinkedWorld, isMigrationMarkedComplete, markMigrationComplete, isBootstrapComplete } from '../character-metadata-db.js';

/**
 * One-time reversal for characters that got auto-converted into a linked World file by the pre-fix
 * importEmbeddedWorldInfo()/world_button flow, back before getCharacterLore() started activating an
 * embedded character_book directly (world-info.js commit 7826cd9ef) and before charUpdatePrimaryWorld()
 * stopped deleting character_book on unlink. Those characters are stuck bound to a World file they never
 * asked to keep around, for a problem that no longer exists.
 *
 * WHICH CHARACTERS QUALIFY - the "originalData" marker
 * ----------------------------------------------------
 * A character only qualifies if it can be proven, not guessed, that its currently-linked World
 * (`data.extensions.world`) was mechanically produced from AN embedded character_book, never a world the
 * user created or picked by hand. That proof exists by accident: convertCharacterBook() (world-info.js)
 * returns `{ entries, originalData: characterBook }`, and every path that turns an embedded book into a
 * saved World file (importEmbeddedWorldInfo(), and the WI editor's "duplicate" action run against the new
 * embedded-lore viewer) saves that whole object as-is - `originalData` and all - straight to the World
 * file's JSON on disk (src/endpoints/worldinfo.js's /edit route writes `request.body.data` verbatim, no
 * schema stripping). A World created any other way (createNewWorldInfo() -> `{ entries: {} }`, or loaded
 * from an existing file and re-saved) never carries `originalData` - nothing else in the client ever sets
 * that key on a world data object. So "does this World file have a top-level `originalData` object with an
 * `entries` array" is a structural fact about how the file came to exist, not a heuristic.
 *
 * THE PART THAT IS A REAL AMBIGUITY - shared/edited worlds
 * ----------------------------------------------------------
 * `originalData` proves a World was *born* from some character's embedded book. It does NOT prove this
 * PARTICULAR character (currently linked to it) is that same character, or that nothing has changed since:
 *   - the user may have deliberately linked a second character to an auto-imported World, to share lore
 *     between them (a genuine manual choice, not a mistake to undo)
 *   - the user (or this fork's new "View/Edit Embedded Lore" feature) may have edited the World's content,
 *     or the character's own embedded copy, since the import, so the two have since diverged
 *   - the character's embedded character_book may itself already be gone (deleted by the very
 *     charUpdatePrimaryWorld() bug this migration exists to clean up after), leaving nothing to compare
 * There is no further signal anywhere in the data to resolve any of this - character_book carries no
 * "created by/for" stamp, and neither does the World file. Rather than guess, this migration only acts
 * automatically when the evidence is unambiguous, and otherwise leaves the character untouched and reports
 * it for manual review:
 *   - exactly one character currently links to that World (`extensions.world` shared by 2+ characters is
 *     treated as deliberate sharing - skipped, all of them, reported)
 *   - AND either the character still has its own character_book and it matches the World's `originalData`
 *     entries (content-equal - the normal case: nothing has diverged) -> unlink only, character_book is
 *     already there and already correct
 *   - OR the character has NO character_book at all (lost to the old delete-on-unlink bug) -> restore
 *     character_book from the World's `originalData` (the last surviving copy) AND unlink
 *   - any other combination (character_book present but diverged from `originalData`) -> ambiguous,
 *     skipped and reported; picking either version would silently discard real user edits to the other
 *
 * WORLD FILE DISPOSAL
 * --------------------
 * The World file itself is never deleted or renamed by this migration, even for a character it does act
 * on. It may still be referenced elsewhere (world_info.charLore's extraBooks, a chat-bound lorebook, the
 * global world-info selector, another character sharing it) that this migration has no reliable way to
 * enumerate for a single user's settings.json across every place a world name can be sitting. Leaving it
 * in place costs nothing (it's inert once nothing has it as a primary link) and is always safe; deleting it
 * out from under some other reference would not be. `run()`'s summary lists every World that ends this run
 * with zero remaining primary/extension links, purely as information for the operator to review and delete
 * by hand if they actually want to.
 *
 * NEVER WALKS THE FULL CHARACTER CORPUS
 * ----------------------------------------
 * findCandidates() does not read every character file, or even every metadata row, to find its (presumably
 * tiny) candidate set - it starts from character-metadata-db.js's getCharactersWithLinkedWorld(), an indexed
 * `WHERE world IS NOT NULL` lookup (idx_characters_world) that returns only characters that could possibly
 * qualify. The multi-linker/"shared World" check is answered entirely from that same result set. Only past
 * that point does this ever open an actual character PNG, and only one per still-live candidate. An install
 * with a billion characters that never linked a world costs this migration one indexed query and nothing
 * else - not a billion file reads, not even a billion row scans. An earlier version of this file read every
 * character into memory up front; tested against this repo's own real (very large) character library, that
 * OOM-crashed after ~29 minutes without producing a result. This design exists because of that, not despite it.
 *
 * AUTO-RUNS ONCE AT BOOT, PER USER, GATED ON A COMPLETION MARKER
 * ------------------------------------------------------------------
 * runOnceAtBoot() is what server-main.js actually calls, in the background after
 * initializeMetadataStores() (never in the awaited boot chain - it does real file writes, which must not
 * delay the server actually starting to listen). "Safe to run once and not repeat" is a real marker, not
 * idempotent-by-construction re-derivation: isMigrationMarkedComplete()/markMigrationComplete()
 * (character-metadata-db.js, the same `meta` key/value table bootstrap_completed already uses) records
 * completion per user, so a later boot returns after one indexed point-lookup rather than re-running
 * anything. It also refuses to trust getCharactersWithLinkedWorld() until isBootstrapComplete() is true for
 * that user - initializeMetadataStores() kicks the one-time metadata backfill off in the background and does
 * not wait for it, so querying the index before that backfill has actually populated the `world` column
 * would silently undercount candidates; a boot where bootstrap hasn't finished yet just retries on the next
 * boot instead of marking itself done on a partial view.
 *
 * The `run()`/`findCandidates()` functions below remain independently usable as a manual CLI tool (`node
 * src/migrations/unimport-embedded-lore.js [--handle X] [--apply]`, defaults to a dry run that only logs what
 * it would do) - useful for inspecting a report before the automatic boot pass ever runs, or for retrying a
 * specific user/candidate by hand after fixing whatever made it fail.
 */

/**
 * Recursively sorts object keys so two structurally-equal-but-differently-ordered values serialize
 * identically. Arrays keep their order (entry order is meaningful).
 * @param {any} value
 * @returns {any}
 */
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

/**
 * Content-equality check between a character's live character_book and a World file's `originalData`,
 * ignoring key order. Only the `entries` array is compared - top-level book metadata (name/description)
 * isn't part of what activation reads and drifting there alone shouldn't block an otherwise-clean unlink.
 * @param {object} characterBook
 * @param {object} originalData
 * @returns {boolean}
 */
function characterBookEntriesMatch(characterBook, originalData) {
    if (!characterBook || !originalData) return false;
    return JSON.stringify(canonicalize(characterBook.entries ?? [])) === JSON.stringify(canonicalize(originalData.entries ?? []));
}

/**
 * Works out, without mutating anything, which characters are safe to unimport and which are ambiguous.
 * See this module's header for the exact rules.
 *
 * DELIBERATELY NEVER walks the full character corpus. Everything starts from
 * getCharactersWithLinkedWorld() - an indexed `WHERE world IS NOT NULL` lookup
 * (character-metadata-db.js's idx_characters_world) that returns only the rows that could possibly
 * qualify. The multi-linker check ("is this World shared by more than one character") is answered
 * entirely from that same result set, with no file I/O at all. Only past that point - for the
 * (presumably tiny) subset that's still a live candidate - does this ever open an actual character
 * PNG, and it opens exactly one per remaining candidate, never anything else in the corpus. On an
 * install with hundreds of thousands or billions of characters that never linked a world, this never
 * reads a single one of their files.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(msg: string) => void} log
 * @returns {Promise<{
 *   safe: Array<{avatar: string, worldName: string, action: 'unlink-only'|'restore-and-unlink'}>,
 *   ambiguous: Array<{avatar: string, worldName: string, reason: string}>,
 * }>}
 */
export async function findCandidates(directories, log) {
    const linked = await getCharactersWithLinkedWorld(directories);
    if (linked === null) {
        throw new Error('Character metadata store is unavailable on this install (no usable SQLite backend) - cannot find candidates without an indexed lookup, and this migration deliberately refuses to fall back to a full-corpus scan to get one. Aborting.');
    }

    /** @type {Map<string, string[]>} worldName -> avatars currently linking to it as their primary world - built purely from the indexed rows, no file I/O. */
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
        if (!hasOriginalDataMarker) continue; // Not an auto-import artifact - a world the user made or picked by hand. Never touched.

        const linkers = linkersByWorld.get(worldName) ?? [];
        if (linkers.length > 1) {
            ambiguous.push({ avatar, worldName, reason: `World is currently linked by ${linkers.length} characters (${linkers.join(', ')}) - treated as deliberate sharing, not touched` });
            continue;
        }

        // Only past this point do we ever open a character file - one PNG for this one remaining
        // candidate, not a corpus walk.
        let card;
        try {
            const rawJson = await parseCharacterCard(path.join(directories.characters, avatar), 'png');
            card = getCharaCardV2(JSON.parse(rawJson), directories, false);
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] Failed to read candidate ${avatar}, skipping: ${err.message}`));
            continue;
        }

        // The metadata row can lag a live edit - re-check the actual card agrees before trusting it further.
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

/**
 * Applies one unimport: unlinks `extensions.world`, restoring `character_book` from the World's
 * `originalData` first if the character doesn't already have one. Never touches the World file itself.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{avatar: string, worldName: string, action: 'unlink-only'|'restore-and-unlink'}} candidate
 * @param {(msg: string) => void} log
 * @returns {Promise<boolean>} True on success.
 */
async function unimportOne(directories, candidate, log) {
    const { avatar, worldName, action } = candidate;
    const avatarPath = path.join(directories.characters, avatar);

    try {
        const rawJson = await parseCharacterCard(avatarPath, 'png');
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

        const stat = await fsPromises.stat(avatarPath);
        await writeCardToFile(avatarPath, avatarPath, JSON.stringify(card));
        await upsertCharacterFromWrite(directories, avatar, JSON.stringify(card), stat.mtimeMs);

        log(color.green(`[unimport-embedded-lore] ${avatar}: unlinked from "${worldName}"${action === 'restore-and-unlink' ? ' and restored its embedded lorebook' : ''}.`));
        return true;
    } catch (err) {
        log(color.red(`[unimport-embedded-lore] Failed to unimport ${avatar}: ${err.message}`));
        return false;
    }
}

/**
 * Runs the full unimport pass for one user. Dry run by default - pass `{ apply: true }` to actually write.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] Defaults to console.log.
 * @param {boolean} [options.apply] Actually write changes. Defaults to false (report only).
 * @returns {Promise<{safe: number, migrated: number, failed: number, ambiguous: Array<{avatar: string, worldName: string, reason: string}>, orphanedWorlds: string[]}>}
 */
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

    // Report-only: worlds carrying the originalData marker that end this run with no primary linker left.
    // Which worlds are still linked comes from the same indexed lookup findCandidates() used - never a
    // character-corpus walk. The worlds directory itself is iterated below (a install can have far fewer
    // World files than characters), which is the one place this function's own cost scales with world count
    // rather than being purely index-driven; it never opens a character file.
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
// How long a boot run waits for THIS user's metadata bootstrap backfill (see isBootstrapComplete()'s own doc
// comment) before giving up for this boot and retrying on the next one. Generous on purpose - a library large
// enough to matter for this migration's own "never walk the corpus" design is also large enough that its
// bootstrap backfill can legitimately still be running well after the server started listening.
const BOOTSTRAP_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const BOOTSTRAP_POLL_INTERVAL_MS = 5000;

/**
 * The actual "auto-run once, for all installs" entry point (server-main.js calls this, in the background,
 * after initializeMetadataStores() - never in the awaited boot chain: even a bounded-to-the-candidate-set
 * migration still does real file writes, which must not delay the server actually starting to listen).
 *
 * Runs at most once ever per user: isMigrationMarkedComplete()/markMigrationComplete() (character-metadata-db.js,
 * the same `meta` table bootstrap_completed already uses) is the completion marker - a later boot sees it set
 * and returns immediately without touching the metadata store's `characters` table at all, so "safe to run once
 * and not repeat" costs one indexed point-lookup per boot, not a scan of anything.
 *
 * Waits for isBootstrapComplete() before ever querying getCharactersWithLinkedWorld() - that query is only
 * trustworthy once the one-time metadata backfill has actually populated the `world` column for every existing
 * character; querying it mid-backfill would silently undercount real candidates, and unlike a live query
 * endpoint that just serves a partial result once, this determines a completion marker that's set forever. If
 * bootstrap doesn't finish within BOOTSTRAP_WAIT_TIMEOUT_MS this boot, this returns without running OR marking
 * anything complete, so the next boot tries again from scratch - never marks itself done on a guess.
 *
 * Always applies (this is the real migration, not the dry-run CLI tool below) but is otherwise the exact same
 * findCandidates()/run() as the manual path - same detection rules, same "never touch anything ambiguous", same
 * "never delete a World file".
 * @param {import('../users.js').UserDirectoryList} directories One user's directories.
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] Defaults to console.log.
 * @param {number} [options.bootstrapWaitTimeoutMs] Overrides BOOTSTRAP_WAIT_TIMEOUT_MS - test hook only.
 * @param {number} [options.bootstrapPollIntervalMs] Overrides BOOTSTRAP_POLL_INTERVAL_MS - test hook only.
 * @returns {Promise<{status: 'already-complete'|'bootstrap-timeout'|'error'|'ran', result?: object}>}
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

    // Marked complete regardless of any individual per-character `failed` count inside result - a failure
    // there is something like a corrupt PNG, which retrying on a later boot would hit again identically. Loud
    // logging already happened inside run()/unimportOne(); this is what actually satisfies "don't repeat every
    // boot" rather than looping on the same unfixable failure forever. A failed character can still be retried
    // deliberately later via the manual `--apply` CLI path below.
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
