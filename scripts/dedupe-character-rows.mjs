#!/usr/bin/env node
/**
 * Row-level counterpart to dedupe-untouched-cards.mjs (which only reflinks PNG files, never touches the
 * `characters` table). Collapses each group of duplicate character rows sharing a content_identity_hash
 * down to one canonical row.
 *
 * Survivor selection: highest real chat_size (verified on disk, not the db column - found to carry
 * phantom values on some rows), then most recent real date_last_chat, then fav=1, then earliest
 * date_added, then lowest id. Not "lowest id wins" - found real cases where that would pick a row with
 * zero chat activity over one with real history.
 *
 * Merge policy for losers, before deletion: fav is OR'd across the group; tags are unioned; active_chat
 * is inherited from a loser only if the survivor has none and the pointer is verified real; every loser's
 * real chat files are moved into the survivor's directory (byte-identical name collisions are dropped,
 * different content gets a "(merged from <loserId>)" suffix - never silently overwritten). A loser's PNG
 * is verified against the survivor by re-deriving content_identity_hash and avatar_identity_hash from
 * current on-disk bytes (not the db's cached columns) rather than a full-byte compare, since two rows
 * sharing content_identity_hash are expected to differ in their embedded chat/create_date JSON.
 *
 * Usage (inside the project's dev shell):
 *   node scripts/dedupe-character-rows.mjs                      (dry run)
 *   node scripts/dedupe-character-rows.mjs --apply
 *   node scripts/dedupe-character-rows.mjs --apply --group-limit 3   (smoke test)
 *   node scripts/dedupe-character-rows.mjs --only <avatar-id>   (only process the group containing this id)
 *
 * Safely re-runnable: once a group's losers are deleted, a re-run's own query no longer sees them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import extract from 'png-chunks-extract';

import { computeContentIdentityHash } from '../src/character-card-normalize.js';
import { computeAvatarIdentityHashFromChunks, readFromChunks } from '../src/character-card-parser.js';

// character-shallow.js reads this env var at module load; must be set before the dynamic import below,
// since static imports would hoist ahead of it.
process.env.SILLYTAVERN_PERFORMANCE_SHALLOWCHARACTERSINCLUDECREATORNOTES ??= 'false';
const { calculateChatSize } = await import('../src/character-shallow.js');

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const CHATS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'chats');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');

/**
 * @typedef {object} CharacterRow
 * @property {string} id
 * @property {string} content_identity_hash
 * @property {number} fav
 * @property {string|null} active_chat
 * @property {number} date_added
 * @property {number} date_last_chat
 * @property {number} chat_size
 */

/**
 * Groups rows sharing content_identity_hash, keeping only groups with more than one member.
 * @param {CharacterRow[]} rows
 * @returns {CharacterRow[][]}
 */
export function buildDuplicateGroups(rows) {
    /** @type {Map<string, CharacterRow[]>} */
    const groups = new Map();
    for (const row of rows) {
        if (!row.content_identity_hash) continue;
        const group = groups.get(row.content_identity_hash);
        if (group) group.push(row);
        else groups.set(row.content_identity_hash, [row]);
    }
    return [...groups.values()].filter(g => g.length > 1);
}

/** Every duplicate row has its own independent chats directory, named after its own id. */
export function getChatDir(chatsDir, id) {
    return path.join(chatsDir, id.replace(/\.png$/, ''));
}

/**
 * Ground-truth chat stats read directly off disk - not the db's chat_size/date_last_chat columns, which
 * were found to carry phantom/stale values on some duplicate rows.
 * @returns {{chatSize: number, dateLastChat: number}}
 */
export function getRealChatStats(chatsDir, id) {
    return calculateChatSize(getChatDir(chatsDir, id));
}

/**
 * Picks the surviving row for one duplicate group. See file header for the selection policy.
 * @returns {{survivor: CharacterRow, losers: CharacterRow[]}}
 */
export function pickSurvivor(group, realStatsById) {
    const sorted = [...group].sort((a, b) => {
        const sa = realStatsById.get(a.id);
        const sb = realStatsById.get(b.id);
        if (sa.chatSize !== sb.chatSize) return sb.chatSize - sa.chatSize;
        if (sa.dateLastChat !== sb.dateLastChat) return sb.dateLastChat - sa.dateLastChat;
        const favA = a.fav ? 1 : 0;
        const favB = b.fav ? 1 : 0;
        if (favA !== favB) return favB - favA;
        if (a.date_added !== b.date_added) return a.date_added - b.date_added;
        return a.id.localeCompare(b.id);
    });
    return { survivor: sorted[0], losers: sorted.slice(1) };
}

/** @returns {boolean} true if the survivor's fav needs flipping to 1 */
export function planFavUpdate(survivor, losers) {
    if (survivor.fav) return false;
    return losers.some(l => !!l.fav);
}

/** @returns {string[]} tag ids present on any loser but not already on the survivor */
export function planTagUnion(db, survivorId, loserIds) {
    const tagsOf = db.prepare('SELECT tag_id FROM character_tags WHERE character_id = ?');
    const existing = new Set(tagsOf.all(survivorId).map(r => r.tag_id));
    const toAdd = new Set();
    for (const loserId of loserIds) {
        for (const r of tagsOf.all(loserId)) {
            if (!existing.has(r.tag_id)) toAdd.add(r.tag_id);
        }
    }
    return [...toAdd];
}

/**
 * Plans every chat file move needed to fold each loser's real chats into the survivor's chat directory.
 * A same-named file already present is skipped if byte-identical, or disambiguated with a suffix if not.
 * @returns {{fromPath: string, toPath: string|null, action: 'move'|'skip-duplicate', loserId: string, fileName: string}[]}
 */
export function planChatMoves(chatsDir, survivorId, loserIds, exists = fs.existsSync, readdir = fs.readdirSync, readFile = fs.readFileSync) {
    const survivorDir = getChatDir(chatsDir, survivorId);
    const moves = [];
    for (const loserId of loserIds) {
        const loserDir = getChatDir(chatsDir, loserId);
        if (!exists(loserDir)) continue;
        let files;
        try {
            files = readdir(loserDir);
        } catch {
            continue;
        }
        for (const fileName of files) {
            const fromPath = path.join(loserDir, fileName);
            let toPath = path.join(survivorDir, fileName);
            if (exists(toPath)) {
                const same = Buffer.compare(readFile(fromPath), readFile(toPath)) === 0;
                if (same) {
                    moves.push({ fromPath, toPath: null, action: 'skip-duplicate', loserId, fileName });
                    continue;
                }
                const ext = path.extname(fileName);
                const base = fileName.slice(0, fileName.length - ext.length);
                const disambiguated = `${base} (merged from ${loserId})${ext}`;
                toPath = path.join(survivorDir, disambiguated);
            }
            moves.push({ fromPath, toPath, action: 'move', loserId, fileName });
        }
    }
    return moves;
}

/**
 * Whether a loser's active_chat pointer should be inherited onto the survivor - only when the survivor has
 * none of its own and the loser's pointer is verified real (dangling pointers are never trusted).
 * @returns {string|null} post-move chat name, or null if nothing should be inherited
 */
export function planActiveChatInherit(survivor, losers, chatMoves) {
    if (survivor.active_chat) return null;
    for (const loser of losers) {
        if (!loser.active_chat) continue;
        const pointedFile = `${loser.active_chat}.jsonl`;
        const move = chatMoves.find(m => m.loserId === loser.id && m.fileName === pointedFile);
        if (!move) continue; // phantom pointer (no matching real file was even planned to move) - ignore it
        if (move.action === 'skip-duplicate') return loser.active_chat; // identical file already on survivor
        return path.basename(move.toPath, '.jsonl');
    }
    return null;
}

/**
 * Verifies a loser's PNG is safe to merge away by re-deriving content_identity_hash and
 * avatar_identity_hash from current on-disk bytes (not the db's cached columns) and requiring both to
 * match the survivor. Not a full-file byte compare: two rows sharing content_identity_hash are expected
 * to differ in their embedded chat/create_date JSON, which a raw compare wouldn't tolerate.
 * @returns {{identical: boolean, reason: string|null}}
 */
export function verifyContentAndAvatarIdentical(charactersDir, survivorId, loserId, exists = fs.existsSync, readFile = fs.readFileSync) {
    const survivorPath = path.join(charactersDir, survivorId);
    const loserPath = path.join(charactersDir, loserId);
    if (!exists(survivorPath) || !exists(loserPath)) return { identical: false, reason: 'missing-file' };

    let survivorChunks, loserChunks;
    try {
        survivorChunks = extract(new Uint8Array(readFile(survivorPath)));
        loserChunks = extract(new Uint8Array(readFile(loserPath)));
    } catch {
        return { identical: false, reason: 'unparseable-png' };
    }

    let survivorChar, loserChar;
    try {
        survivorChar = JSON.parse(readFromChunks(survivorChunks));
        loserChar = JSON.parse(readFromChunks(loserChunks));
    } catch {
        return { identical: false, reason: 'unparseable-card-json' };
    }

    if (computeContentIdentityHash(survivorChar) !== computeContentIdentityHash(loserChar)) {
        return { identical: false, reason: 'content-mismatch' };
    }
    if (computeAvatarIdentityHashFromChunks(survivorChunks) !== computeAvatarIdentityHashFromChunks(loserChunks)) {
        return { identical: false, reason: 'avatar-mismatch' };
    }
    return { identical: true, reason: null };
}

/** Builds the full merge plan for one duplicate group without touching anything. */
export function planGroupMerge(group, { db, charactersDir, chatsDir }) {
    const realStatsById = new Map(group.map(r => [r.id, getRealChatStats(chatsDir, r.id)]));
    const { survivor, losers } = pickSurvivor(group, realStatsById);

    const byteChecks = losers.map(loser => ({ loserId: loser.id, ...verifyContentAndAvatarIdentical(charactersDir, survivor.id, loser.id) }));
    const needsReview = byteChecks.some(c => !c.identical);
    if (needsReview) {
        return {
            survivor, losers, needsReview: true,
            reviewReason: byteChecks.filter(c => !c.identical).map(c => `${c.loserId}: ${c.reason}`).join('; '),
        };
    }

    const favUpdate = planFavUpdate(survivor, losers);
    const tagsToAdd = planTagUnion(db, survivor.id, losers.map(l => l.id));
    const chatMoves = planChatMoves(chatsDir, survivor.id, losers.map(l => l.id));
    const activeChatInherit = planActiveChatInherit(survivor, losers, chatMoves);
    const survivorRealStats = realStatsById.get(survivor.id);
    const movedIn = chatMoves.filter(m => m.action === 'move');
    const chatStatsAfterMerge = {
        chatSize: survivorRealStats.chatSize + movedIn.reduce((sum, m) => sum + fs.statSync(m.fromPath).size, 0),
        dateLastChat: Math.max(survivorRealStats.dateLastChat, ...losers.map(l => realStatsById.get(l.id).dateLastChat)),
    };

    return {
        survivor, losers, needsReview: false,
        favUpdate, tagsToAdd, chatMoves, activeChatInherit, chatStatsAfterMerge,
    };
}

function setFavSync(db, id, fav) {
    const existing = db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id);
    const shallow = JSON.parse(existing.shallow_json);
    shallow.fav = !!fav;
    const { lastInsertRowid } = db.prepare('INSERT INTO changes (id, op) VALUES (?, ?)').run(id, 'upsert');
    db.prepare('UPDATE characters SET fav = ?, shallow_json = ?, rev = ? WHERE id = ?')
        .run(fav ? 1 : 0, JSON.stringify(shallow), Number(lastInsertRowid), id);
}

function setActiveChatSync(db, id, chat) {
    const existing = db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id);
    const shallow = JSON.parse(existing.shallow_json);
    shallow.chat = chat;
    const { lastInsertRowid } = db.prepare('INSERT INTO changes (id, op) VALUES (?, ?)').run(id, 'upsert');
    db.prepare('UPDATE characters SET active_chat = ?, shallow_json = ?, rev = ? WHERE id = ?')
        .run(chat, JSON.stringify(shallow), Number(lastInsertRowid), id);
}

function addTagSync(db, id, tagId) {
    db.prepare('INSERT OR IGNORE INTO character_tags (character_id, tag_id) VALUES (?, ?)').run(id, tagId);
}

function refreshChatStatsSync(db, id, chatSize, dateLastChat) {
    const existing = db.prepare('SELECT shallow_json FROM characters WHERE id = ?').get(id);
    const shallow = JSON.parse(existing.shallow_json);
    shallow.chat_size = chatSize;
    shallow.date_last_chat = dateLastChat;
    const { lastInsertRowid } = db.prepare('INSERT INTO changes (id, op) VALUES (?, ?)').run(id, 'upsert');
    db.prepare('UPDATE characters SET chat_size = ?, date_last_chat = ?, shallow_json = ?, rev = ? WHERE id = ?')
        .run(chatSize, dateLastChat, JSON.stringify(shallow), Number(lastInsertRowid), id);
}

/** Mirrors deleteRowSync() in src/character-metadata-db.js (not exported there). */
function deleteCharacterRowSync(db, id) {
    db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    db.prepare('DELETE FROM character_tags WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM local_import_mtimes WHERE duplicate_of = ?').run(id);
    db.prepare('INSERT INTO changes (id, op) VALUES (?, ?)').run(id, 'delete');
}

/**
 * Executes one already-verified plan: moves chat files, applies fav/tags/active_chat/chat-stats merges
 * onto the survivor, deletes each loser's row, PNG, and chat directory. File moves happen first and are
 * individually safe to re-run, so a failure partway through is recoverable by re-running the script.
 */
function applyGroupMerge(plan, db, charactersDir, chatsDir) {
    const { survivor, losers, favUpdate, tagsToAdd, chatMoves, activeChatInherit, chatStatsAfterMerge } = plan;

    for (const move of chatMoves) {
        if (move.action !== 'move') continue;
        fs.mkdirSync(path.dirname(move.toPath), { recursive: true });
        fs.renameSync(move.fromPath, move.toPath);
    }
    // Clean up now-empty (or skip-duplicate-only) loser chat directories.
    for (const loser of losers) {
        const dir = getChatDir(chatsDir, loser.id);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    db.transaction(() => {
        if (favUpdate) setFavSync(db, survivor.id, true);
        for (const tagId of tagsToAdd) addTagSync(db, survivor.id, tagId);
        if (activeChatInherit) setActiveChatSync(db, survivor.id, activeChatInherit);
        if (chatMoves.some(m => m.action === 'move')) {
            refreshChatStatsSync(db, survivor.id, chatStatsAfterMerge.chatSize, chatStatsAfterMerge.dateLastChat);
        }
        for (const loser of losers) {
            deleteCharacterRowSync(db, loser.id);
        }
    })();

    for (const loser of losers) {
        const pngPath = path.join(charactersDir, loser.id);
        if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
    }
}

function formatPlan(plan) {
    const lines = [];
    lines.push(`group ${plan.survivor.content_identity_hash} - survivor: ${plan.survivor.id} (${plan.survivor.name || '(no name)'})`);
    if (plan.needsReview) {
        lines.push(`  NEEDS REVIEW - ${plan.reviewReason} - group left untouched`);
        return lines.join('\n');
    }
    lines.push(`  losers (${plan.losers.length}): ${plan.losers.map(l => l.id).join(', ')}`);
    if (plan.favUpdate) lines.push('  fav: survivor becomes favorited (a loser was favorited)');
    if (plan.tagsToAdd.length) lines.push(`  tags: +${plan.tagsToAdd.length} tag(s) unioned onto survivor`);
    const moves = plan.chatMoves.filter(m => m.action === 'move');
    const skips = plan.chatMoves.filter(m => m.action === 'skip-duplicate');
    if (moves.length) lines.push(`  chat files: ${moves.length} moved onto survivor (${moves.filter(m => path.basename(m.toPath) !== m.fileName).length} renamed to avoid collision)`);
    if (skips.length) lines.push(`  chat files: ${skips.length} identical duplicate(s) dropped (already present on survivor)`);
    if (plan.activeChatInherit) lines.push(`  active_chat: inherited "${plan.activeChatInherit}" from a loser`);
    return lines.join('\n');
}

/**
 * @param {CharacterRow[]} rows All rows carrying a content_identity_hash.
 * @param {object} [options]
 * @param {string} [options.only] Only process the group containing this id.
 */
export function runMergeSweep(rows, options) {
    const {
        apply = false,
        groupLimit = Infinity,
        only = null,
        db,
        charactersDir = CHARACTERS_DIR,
        chatsDir = CHATS_DIR,
        log = console.log,
    } = options;

    let groups = buildDuplicateGroups(rows);
    if (only) {
        groups = groups.filter(g => g.some(r => r.id === only));
    }

    const counters = { groups: groups.length, applied: 0, needsReview: 0, losersRemoved: 0, tagsAdded: 0, chatFilesMoved: 0, favInherited: 0, activeChatInherited: 0 };

    let processed = 0;
    for (const group of groups) {
        if (processed >= groupLimit) break;
        const plan = planGroupMerge(group, { db, charactersDir, chatsDir });
        log(formatPlan(plan));

        if (plan.needsReview) {
            counters.needsReview++;
            continue;
        }

        processed++;
        if (plan.favUpdate) counters.favInherited++;
        if (plan.activeChatInherit) counters.activeChatInherited++;
        counters.tagsAdded += plan.tagsToAdd.length;
        counters.chatFilesMoved += plan.chatMoves.filter(m => m.action === 'move').length;
        counters.losersRemoved += plan.losers.length;

        if (apply) {
            applyGroupMerge(plan, db, charactersDir, chatsDir);
            counters.applied++;
        }
    }

    return counters;
}

async function main() {
    const args = process.argv.slice(2);
    const APPLY = args.includes('--apply');
    const groupLimitIndex = args.indexOf('--group-limit');
    const GROUP_LIMIT = groupLimitIndex !== -1 ? Number(args[groupLimitIndex + 1]) : Infinity;
    const onlyIndex = args.indexOf('--only');
    const ONLY = onlyIndex !== -1 ? args[onlyIndex + 1] : null;

    console.log(`Mode: ${APPLY ? 'APPLY (rows/files WILL be modified/deleted)' : 'DRY RUN (nothing touched - pass --apply to perform the merge)'}`);
    if (Number.isFinite(GROUP_LIMIT)) console.log(`Groups capped at ${GROUP_LIMIT} (--group-limit) - not a full run.`);
    if (ONLY) console.log(`Only processing the group containing: ${ONLY}`);
    console.log('');

    const db = new Database(DB_PATH, { readonly: !APPLY });
    const rows = db.prepare('SELECT id, name, content_identity_hash, fav, active_chat, date_added, date_last_chat, chat_size FROM characters WHERE content_identity_hash IS NOT NULL').all();
    console.log(`${rows.length} character rows carry a content_identity_hash to group.`);
    console.log('');

    const counters = runMergeSweep(rows, { apply: APPLY, groupLimit: GROUP_LIMIT, only: ONLY, db });
    db.close();

    console.log('');
    console.log('--- summary ---');
    console.log(`duplicate groups found:      ${counters.groups}`);
    console.log(`  needs manual review:       ${counters.needsReview}`);
    console.log(`  ${APPLY ? 'applied' : 'would apply'}:                   ${APPLY ? counters.applied : counters.groups - counters.needsReview}`);
    console.log(`  loser rows ${APPLY ? 'removed' : 'that would be removed'}: ${counters.losersRemoved}`);
    console.log(`  fav inherited onto survivor:     ${counters.favInherited}`);
    console.log(`  active_chat inherited:           ${counters.activeChatInherited}`);
    console.log(`  tags unioned onto survivors:     ${counters.tagsAdded}`);
    console.log(`  chat files moved onto survivors: ${counters.chatFilesMoved}`);
    if (!APPLY) console.log('(dry run only - re-run with --apply to actually perform the merge)');
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
