import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { color, uuidv7, isUuidLike } from '../util.js';
import { parse as parseCharacterCard } from '../character-card-parser.js';
import { getCharaCardV2 } from '../character-card-normalize.js';
import { readSettingsAtPaths, writeSettingsKeys } from '../settings-store.js';
import {
    upsertCharacterFromWrite,
    getCharacterCardJson,
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
 * Migrates every character file from a name-derived filename to an immutable UUIDv7, rewriting all references.
 * Restartable/idempotent: each step checks current on-disk/db state rather than a "have I run" flag.
 */

/**
 * @returns {Promise<string>} A `<uuid>.png` avatar filename not already claimed on disk or in `id_migration`.
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
 * Records an old_id -> new_id mapping for every not-yet-migrated file, before any mutation happens.
 * @returns {Promise<number>} How many new mappings were recorded this call.
 */
async function discoverPendingMigrations(directories, log) {
    if (!fs.existsSync(directories.characters)) return 0;
    const files = (await fsPromises.readdir(directories.characters)).filter(f => f.toLowerCase().endsWith('.png'));

    let discovered = 0;
    for (const file of files) {
        const stem = path.parse(file).name;
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
 * Performs the per-character identity move for one old_id/new_id pair: PNG rename, metadata row, chats directory.
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
    // else: !oldExists && newExists - already renamed by a prior interrupted run; fall through.

    try {
        // parked copy (if any) is still keyed by the OLD id here - rename happened but renameCharacterRow()
        // below hasn't moved the row yet.
        const parked = await getCharacterCardJson(directories, oldId);
        const rawJson = parked ?? await parseCharacterCard(newPath, 'png');
        const normalized = JSON.stringify(getCharaCardV2(JSON.parse(rawJson), directories, false));
        const stat = await fsPromises.stat(newPath);
        await upsertCharacterFromWrite(directories, newId, normalized, stat.mtimeMs, null, null);
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
 * extensionless stem), `extension_settings.note.chara` (keyed by the full avatar filename), and `active_character`.
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

    const current = readSettingsAtPaths(directories, ['world_info_settings', 'extension_settings', 'active_character']);
    /** @type {Record<string, unknown>} */
    const updates = {};

    const charLore = current.world_info_settings?.world_info?.charLore;
    if (Array.isArray(charLore)) {
        let worldInfoChanged = false;
        for (const entry of charLore) {
            if (entry && byStem.has(entry.name)) {
                entry.name = byStem.get(entry.name);
                worldInfoChanged = true;
            }
        }
        if (worldInfoChanged) {
            updates.world_info_settings = current.world_info_settings;
        }
    }

    const noteChara = current.extension_settings?.note?.chara;
    if (Array.isArray(noteChara)) {
        let extensionSettingsChanged = false;
        for (const entry of noteChara) {
            if (entry && byAvatar.has(entry.name)) {
                entry.name = byAvatar.get(entry.name);
                extensionSettingsChanged = true;
            }
        }
        if (extensionSettingsChanged) {
            updates.extension_settings = current.extension_settings;
        }
    }

    if (typeof current.active_character === 'string' && byAvatar.has(current.active_character)) {
        updates.active_character = byAvatar.get(current.active_character);
    }

    if (Object.keys(updates).length > 0) {
        writeSettingsKeys(directories, updates);
    }
}

/**
 * Runs the full filename migration for one user: discover pending files, migrate each one, sweep cross-cutting
 * references, then rebuild the search index. Safe to call repeatedly and safe to interrupt at any point.
 * @param {object} [options]
 * @param {boolean | (handle: string, directories: import('../users.js').UserDirectoryList) => Promise<any>} [options.rebuildSearchIndex]
 * `false` skips the rebuild; a function overrides which rebuild call is made.
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
