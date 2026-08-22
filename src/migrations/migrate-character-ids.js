import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color, uuidv7, isUuidLike } from '../util.js';
import { parse as parseCharacterCard } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import {
    upsertCharacterFromWrite,
    renameCharacterRow,
    recordIdMigrationMapping,
    getIdMigrationMapping,
    isIdMigrationTargetTaken,
    markIdMigrationComplete,
    getPendingIdMigrations,
    getCompletedIdMigrations,
} from '../character-metadata-db.js';
import { rebuildCharacterSearchIndex } from '../endpoints/characters-search-index.js';

/**
 * The one-time filename migration for the character-data-residency redesign (design doc §2.2, §9 phase 4d):
 * every character file on disk moves from a name-derived filename to an immutable, opaque UUIDv7, and every
 * other place that references the old filename gets rewritten to match.
 *
 * RESTARTABLE AND IDEMPOTENT BY CONSTRUCTION, not by a single "have I run" flag - the doc is explicit that a
 * 300k+-character run WILL be interrupted:
 *
 *   1. discoverPendingMigrations() durably records an old_id -> new_id mapping (character-metadata-db.js's
 *      `id_migration` table) for every not-yet-migrated file BEFORE any mutation happens. A resumed run reuses
 *      the same new_id it minted last time rather than minting a fresh one (see recordIdMigrationMapping()'s own
 *      doc comment) - the discriminator for "not yet migrated" is "is the filename stem shaped like a UUID",
 *      never a guess based on what the name looks like.
 *   2. migrateOne() performs the actual per-character move (PNG rename, metadata row, chats directory). Every
 *      step checks CURRENT on-disk/db state rather than trusting a prior run got anywhere in particular, so
 *      re-running it for an already-fully-migrated pair - or resuming mid-way through a half-finished one - is
 *      always safe: each step is a no-op if its own effect is already visible.
 *   3. sweepCrossCuttingReferences() rewrites everywhere else an old avatar filename can be sitting (groups,
 *      world_info's charLore, extension_settings.note.chara, active_character), but ONLY for pairs
 *      migrateOne() has already marked complete - see the `id_migration` table's schema comment in
 *      character-metadata-db.js for why. It only rewrites a source file if it actually changed, so re-running it
 *      after every character is already migrated is a cheap no-op scan, not a mistake.
 *
 * Deliberately NOT run against the live install's real character library as part of landing this file - see the
 * task report for why (multi-hundred-GB corpus, needs an explicit owner-triggered run, not an automatic one).
 */

/**
 * Mints a fresh id for a character being migrated, checking collision against both the filesystem and other
 * in-flight/finished migration rows in the same run (design doc §0 decision 1, "correctness over cost" - even
 * though a UUIDv7 collision is practically impossible, this never silently reuses or overwrites).
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<string>} A `<uuid>.png` avatar filename not already claimed by anything on disk or in
 * `id_migration`.
 */
async function mintUnusedId(directories) {
    for (let i = 0; i < 5; i++) {
        const candidateAvatar = `${uuidv7()}.png`;
        if (fs.existsSync(path.join(directories.characters, candidateAvatar))) continue;
        if (await isIdMigrationTargetTaken(directories, candidateAvatar)) continue;
        return candidateAvatar;
    }
    throw new Error('Failed to mint a unique migration target id after 5 attempts');
}

/**
 * Scans `directories.characters` for files that still need migrating and durably records an old_id -> new_id
 * mapping for each one that doesn't already have one (from this or a prior interrupted run). See this module's
 * header for why this has to happen before any mutation.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(msg: string) => void} log
 * @returns {Promise<number>} How many new mappings were recorded this call.
 */
async function discoverPendingMigrations(directories, log) {
    if (!fs.existsSync(directories.characters)) return 0;
    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.toLowerCase().endsWith('.png'));

    let discovered = 0;
    for (const file of files) {
        const stem = path.parse(file).name;
        // The idempotency test the design doc asks for explicitly: "is it a valid uuid, not just does it look
        // like a plausible name" - never a heuristic on the display name.
        if (isUuidLike(stem)) continue;

        const existingMapping = await getIdMigrationMapping(directories, file);
        if (existingMapping) continue;

        const newAvatar = await mintUnusedId(directories);
        await recordIdMigrationMapping(directories, file, newAvatar);
        discovered++;
    }

    if (discovered > 0) {
        log(color.cyan(`[migrate-character-ids] Discovered ${discovered} character(s) needing migration.`));
    }
    return discovered;
}

/**
 * Performs the per-character identity move for one old_id/new_id pair: PNG rename, metadata row, chats
 * directory. See this module's header on why every step is conditioned on current state rather than a "did I do
 * this" flag.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} oldId Old avatar filename, e.g. `Alice.png`
 * @param {string} newId New avatar filename, e.g. `<uuid>.png`
 * @param {(msg: string) => void} log
 * @returns {Promise<boolean>} True if the pair is (now) fully migrated.
 */
async function migrateOne(directories, oldId, newId, log) {
    const oldPath = path.join(directories.characters, oldId);
    const newPath = path.join(directories.characters, newId);

    const oldExists = fs.existsSync(oldPath);
    const newExists = fs.existsSync(newPath);

    if (oldExists && !newExists) {
        await fsPromises.rename(oldPath, newPath);
    } else if (!oldExists && !newExists) {
        log(color.red(`[migrate-character-ids] Neither ${oldId} nor ${newId} exists on disk - cannot migrate this row, leaving it pending for manual review.`));
        return false;
    } else if (oldExists && newExists) {
        log(color.yellow(`[migrate-character-ids] Both ${oldId} and ${newId} already exist on disk - leaving both in place and this row pending rather than guessing which is canonical.`));
        return false;
    }
    // else: !oldExists && newExists - the file was already renamed by a prior (interrupted) run; fall through to
    // the remaining steps, which will find themselves already done too and no-op.

    try {
        const rawJson = await parseCharacterCard(newPath, 'png');
        // Mirrors bootstrapIfNeeded()'s own normalization (character-metadata-db.js) - upsertCharacterFromWrite()
        // expects an already Spec-V2-normalized card, the same way every characters.js write route already
        // normalizes before calling it.
        const normalized = JSON.stringify(getCharaCardV2(JSON.parse(rawJson), directories, false));
        const stat = await fsPromises.stat(newPath);
        // Same two-call shape characters.js's old /rename route used: a generic upsert for the new id first (so
        // renameCharacterRow() has a row to patch), then renameCharacterRow() carries date_added/tags forward
        // and removes the old row. Both are themselves idempotent - see their own doc comments.
        await upsertCharacterFromWrite(directories, newId, normalized, stat.mtimeMs);
        await renameCharacterRow(directories, oldId, newId);
    } catch (err) {
        log(color.red(`[migrate-character-ids] Failed to update the metadata store for ${oldId} -> ${newId}: ${err.message}`));
        return false;
    }

    const oldStem = path.parse(oldId).name;
    const newStem = path.parse(newId).name;
    const oldChatsPath = path.join(directories.chats, oldStem);
    const newChatsPath = path.join(directories.chats, newStem);
    if (fs.existsSync(oldChatsPath) && !fs.existsSync(newChatsPath)) {
        await fsPromises.rename(oldChatsPath, newChatsPath);
    } else if (fs.existsSync(oldChatsPath) && fs.existsSync(newChatsPath)) {
        log(color.yellow(`[migrate-character-ids] Both chat directories ${oldStem} and ${newStem} already exist - leaving both in place rather than guessing which to keep.`));
    }

    await markIdMigrationComplete(directories, oldId);
    return true;
}

/**
 * Rewrites every other place an old avatar filename can be sitting, for pairs already marked complete by
 * migrateOne(): group `members`/`disabled_members`, `world_info_settings.world_info.charLore` (keyed by the
 * extensionless stem), `extension_settings.note.chara` (keyed by the full avatar filename), and
 * `active_character`. Only rewrites a source file if something in it actually changed, so calling this again
 * once every character is migrated is a cheap no-op scan.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {(msg: string) => void} log
 */
async function sweepCrossCuttingReferences(directories, log) {
    const completed = await getCompletedIdMigrations(directories);
    if (completed.length === 0) return;

    const byAvatar = new Map(completed.map(row => [row.old_id, row.new_id]));
    const byStem = new Map(completed.map(row => [path.parse(row.old_id).name, path.parse(row.new_id).name]));

    if (directories.groups && fs.existsSync(directories.groups)) {
        const groupFiles = (await fsPromises.readdir(directories.groups)).filter(f => f.endsWith('.json'));
        for (const file of groupFiles) {
            const groupPath = path.join(directories.groups, file);
            let group;
            try {
                group = JSON.parse(await fsPromises.readFile(groupPath, 'utf8'));
            } catch (err) {
                log(color.red(`[migrate-character-ids] Failed to read group file ${file}, skipping: ${err.message}`));
                continue;
            }

            let changed = false;
            for (const field of ['members', 'disabled_members']) {
                if (!Array.isArray(group[field])) continue;
                const rewritten = group[field].map(avatar => byAvatar.has(avatar) ? byAvatar.get(avatar) : avatar);
                if (rewritten.some((value, i) => value !== group[field][i])) {
                    group[field] = rewritten;
                    changed = true;
                }
            }

            if (changed) {
                await fsPromises.writeFile(groupPath, JSON.stringify(group, null, 4), 'utf8');
            }
        }
    }

    const settingsPath = path.join(directories.root, 'settings.json');
    if (fs.existsSync(settingsPath)) {
        let settings;
        try {
            settings = JSON.parse(await fsPromises.readFile(settingsPath, 'utf8'));
        } catch (err) {
            log(color.red(`[migrate-character-ids] Failed to read settings.json, skipping the cross-cutting rewrite: ${err.message}`));
            return;
        }

        let changed = false;

        const charLore = settings?.world_info_settings?.world_info?.charLore;
        if (Array.isArray(charLore)) {
            for (const entry of charLore) {
                if (entry && byStem.has(entry.name)) {
                    entry.name = byStem.get(entry.name);
                    changed = true;
                }
            }
        }

        const noteChara = settings?.extension_settings?.note?.chara;
        if (Array.isArray(noteChara)) {
            for (const entry of noteChara) {
                if (entry && byAvatar.has(entry.name)) {
                    entry.name = byAvatar.get(entry.name);
                    changed = true;
                }
            }
        }

        if (typeof settings?.active_character === 'string' && byAvatar.has(settings.active_character)) {
            settings.active_character = byAvatar.get(settings.active_character);
            changed = true;
        }

        if (changed) {
            await fsPromises.writeFile(settingsPath, JSON.stringify(settings, null, 4), 'utf8');
        }
    }
}

/**
 * Runs the full phase 4d filename migration for one user: discover pending files, migrate each one, sweep
 * cross-cutting references, then (by default) trigger a search-index repair so tantivy/FTS5 reflects the new
 * ids too. Safe to call repeatedly and safe to interrupt at any point - see this module's header.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] Defaults to console.log.
 * @param {string} [options.handle] User handle, passed through to the search-index rebuild. Defaults to `'default-user'`.
 * @param {boolean | (handle: string, directories: import('../users.js').UserDirectoryList) => Promise<any>} [options.rebuildSearchIndex]
 * `false` skips the rebuild entirely (useful in tests); a function overrides which rebuild call is made; omitted
 * uses the real `rebuildCharacterSearchIndex`.
 * @returns {Promise<{ discovered: number, migrated: number, failed: number, total: number, indexResult: any }>}
 */
export async function migrateCharacterIds(directories, options = {}) {
    const log = options.log ?? console.log;

    const discovered = await discoverPendingMigrations(directories, log);

    const pending = await getPendingIdMigrations(directories);
    log(`[migrate-character-ids] ${pending.length} character(s) pending migration.`);

    let migrated = 0;
    let failed = 0;
    const start = Date.now();
    let lastProgress = start;
    for (const { old_id, new_id } of pending) {
        const ok = await migrateOne(directories, old_id, new_id, log);
        if (ok) migrated++; else failed++;

        const now = Date.now();
        if (now - lastProgress >= 5000) {
            log(`[migrate-character-ids] Progress: ${migrated + failed}/${pending.length} (${migrated} migrated, ${failed} failed)`);
            lastProgress = now;
        }
    }

    await sweepCrossCuttingReferences(directories, log);

    let indexResult = null;
    if (options.rebuildSearchIndex !== false) {
        const rebuild = typeof options.rebuildSearchIndex === 'function' ? options.rebuildSearchIndex : rebuildCharacterSearchIndex;
        try {
            indexResult = await rebuild(options.handle ?? 'default-user', directories);
        } catch (err) {
            log(color.red(`[migrate-character-ids] Search index rebuild failed: ${err.message}`));
        }
    }

    log(color.green(`[migrate-character-ids] Done: ${migrated}/${pending.length} migrated, ${failed} failed, ${discovered} newly discovered this run.`));
    return { discovered, migrated, failed, total: pending.length, indexResult };
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const { initConfig } = await import('../config-init.js');
    const { getUserDirectories } = await import('../users.js');

    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };

    const dataRoot = getArg('data-root', './data');
    const handle = getArg('handle', 'default-user');
    const configPath = getArg('config', './config.yaml');

    globalThis.DATA_ROOT = dataRoot;
    initConfig(configPath);

    const directories = getUserDirectories(handle);
    console.log(color.cyan(`[migrate-character-ids] Migrating handle "${handle}" under data root "${dataRoot}"...`));

    migrateCharacterIds(directories, { handle })
        .then((result) => {
            if (result.failed > 0) {
                console.error(color.red(`[migrate-character-ids] ${result.failed} row(s) could not be migrated - re-run this script after investigating (see the warnings above); it will pick up only what's still pending.`));
                process.exitCode = 1;
            }
        })
        .catch((err) => {
            console.error(color.red('[migrate-character-ids] Migration run failed:'), err);
            process.exitCode = 1;
        });
}
