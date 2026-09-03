import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color } from '../util.js';
import { parse as parseCharacterCard, writeCardToFile } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readWorldInfoFile } from '../endpoints/worldinfo.js';
import { upsertCharacterFromWrite } from '../character-metadata-db.js';

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
 * NOT WIRED TO SERVER BOOT
 * --------------------------
 * This deliberately follows migrate-character-ids.js's own precedent (see that module's header): a
 * migration that rewrites real character card files is an explicit, owner-triggered run (`node
 * src/migrations/unimport-embedded-lore.js`), never something that fires automatically the next time a
 * server happens to start up. "Safe to run once and not repeat" is met by being idempotent BY
 * CONSTRUCTION rather than by a ran-once flag: after a character is unimported, its `extensions.world` no
 * longer points at anything, so findCandidates() simply won't see it again on a later run - same
 * reasoning migrate-character-ids.js's header gives for skipping a single "have I run" flag in favor of
 * re-checking current state every time. Defaults to a dry run that only logs what it would do; pass
 * `--apply` (CLI) or `{ apply: true }` (programmatic) to actually write anything.
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
 * Reads every character file in `directories.characters` into `{ avatar, card }` pairs, skipping (and
 * logging) any file that fails to parse rather than aborting the whole run over one bad card.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(msg: string) => void} log
 * @returns {Promise<Array<{avatar: string, card: object}>>}
 */
async function readAllCharacters(directories, log) {
    if (!fs.existsSync(directories.characters)) return [];
    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.toLowerCase().endsWith('.png'));

    const characters = [];
    for (const avatar of files) {
        try {
            const rawJson = await parseCharacterCard(path.join(directories.characters, avatar), 'png');
            const card = getCharaCardV2(JSON.parse(rawJson), directories, false);
            characters.push({ avatar, card });
        } catch (err) {
            log(color.red(`[unimport-embedded-lore] Failed to read ${avatar}, skipping: ${err.message}`));
        }
    }
    return characters;
}

/**
 * Works out, without mutating anything, which characters are safe to unimport and which are ambiguous.
 * See this module's header for the exact rules.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(msg: string) => void} log
 * @returns {Promise<{
 *   safe: Array<{avatar: string, worldName: string, action: 'unlink-only'|'restore-and-unlink'}>,
 *   ambiguous: Array<{avatar: string, worldName: string, reason: string}>,
 * }>}
 */
export async function findCandidates(directories, log) {
    const characters = await readAllCharacters(directories, log);

    /** @type {Map<string, string[]>} worldName -> avatars currently linking to it as their primary world */
    const linkersByWorld = new Map();
    for (const { avatar, card } of characters) {
        const worldName = card?.data?.extensions?.world;
        if (!worldName) continue;
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

    for (const { avatar, card } of characters) {
        const worldName = card?.data?.extensions?.world;
        if (!worldName) continue;

        const world = loadWorld(worldName);
        const hasOriginalDataMarker = !!(world && world.originalData && Array.isArray(world.originalData.entries));
        if (!hasOriginalDataMarker) continue; // Not an auto-import artifact - a world the user made or picked by hand. Never touched.

        const linkers = linkersByWorld.get(worldName) ?? [];
        if (linkers.length > 1) {
            ambiguous.push({ avatar, worldName, reason: `World is currently linked by ${linkers.length} characters (${linkers.join(', ')}) - treated as deliberate sharing, not touched` });
            continue;
        }

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
    const characters = await readAllCharacters(directories, log);
    const stillLinked = new Set(characters.map(c => c?.card?.data?.extensions?.world).filter(Boolean));
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
