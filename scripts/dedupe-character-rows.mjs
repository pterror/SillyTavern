#!/usr/bin/env node
/**
 * Row-level counterpart to dedupe-untouched-cards.mjs (which only reflinks PNG files on disk and never touches
 * the `characters` table). This script collapses each group of duplicate CHARACTER ROWS - not just files - down
 * to one canonical row, for the ~33k real duplicate rows created by the mtime-reset rescan bug fixed in
 * 63706aef3 (fix(character-metadata-db): stop findCharacterIdByIdentityHashes false-negative on unbackfilled
 * avatar_identity_hash).
 *
 * Grouping is the same content_identity_hash equality dedupe-untouched-cards.mjs uses - by construction, any two
 * rows sharing that hash are identical except for install-local fav/chat/create_date state (see that script's
 * header). That's exactly the state this script has to reconcile before a row can be safely deleted.
 *
 * SURVIVOR SELECTION - audited against the owner's real 359k-row library before being written, not assumed:
 *   1. Highest REAL chat_size, verified against the chat directory on disk (getRealChatStats() below) - NOT
 *      the `chat_size` db column, which was found to carry phantom values on some duplicate rows (a group whose
 *      id was literally ".png" claimed a 1.3MB chat_size with no chats directory on disk at all - a corrupt
 *      edge case flagged for manual review, not trusted).
 *   2. Tie -> most recent real date_last_chat.
 *   3. Tie -> fav = 1 beats fav = 0.
 *   4. Tie -> earliest date_added (closer to the original import).
 *   5. Tie -> lowest id, purely for determinism.
 * Deliberately NOT "lowest id wins" (dedupe-untouched-cards.mjs's policy for picking a reflink source) - audited
 * against the real library and found at least one real case ("Mommy Unohana.png" vs a UUID-named duplicate)
 * where lowest-id would have picked the row with zero chat activity over the one with real chat history.
 *
 * MERGE POLICY for the losing rows' state, once a survivor is picked:
 *   - fav: OR across the whole group - if ANY row is favorited, the survivor ends up favorited. Never lost.
 *   - tags: UNION across the whole group (character_tags), not just the survivor's own set. Same shape
 *     renameCharacterRow() already uses for a same-character-continues-to-exist merge (character-metadata-db.js).
 *   - active_chat: inherited from a loser ONLY if the survivor doesn't already have one AND the pointer is
 *     verified real (the loser's own chat directory actually contains that exact chat file - a phantom/dangling
 *     pointer, confirmed to exist in the real library, is never trusted). If the pointed-to file gets renamed
 *     during the chat-file merge below (collision), the inherited pointer is updated to match.
 *   - chat files: every loser with a REAL (non-empty, on-disk) chats directory gets those chat files MOVED into
 *     the survivor's chat directory before the row is deleted - never silently dropped. A same-named file already
 *     present in the survivor's directory is left alone if byte-identical, or renamed with a
 *     "(merged from <loserId>)" suffix if it's genuinely different content. This was found necessary against a
 *     real case: two duplicate rows ("Lucy Liubot.png" / "Lucy Liubot1.png") each carrying a *different* real
 *     chat file that coincidentally share the same byte size - collapsing them with a naive delete would have
 *     silently destroyed one of the two conversations.
 *   - PNG files: the loser's PNG is verified against the survivor's PNG before anything is deleted, by
 *     RE-DERIVING both content_identity_hash and avatar_identity_hash live from each file's current on-disk
 *     bytes (never trusting the db's cached columns) and requiring both to match. A naive full-file byte
 *     compare was tried first and rejected: it declined literally every real duplicate pair in the owner's
 *     library (verified against "Amber & Tyler.png" / "Amber & Tyler1.png" - byte-identical 5.2MB portrait,
 *     the only difference anywhere in the file was the embedded `chat`/`create_date` JSON fields, which
 *     content_identity_hash deliberately strips before hashing per this script's own grouping rule above; a
 *     full-byte compare was rejecting on exactly the difference the grouping already knows to ignore, making
 *     the whole script a no-op). Re-deriving the two identity hashes fresh is the correct, still-strict check:
 *     avatar_identity_hash covers only the IDAT (pixel) bytes, content_identity_hash covers everything else
 *     minus fav/chat/create_date - between them, any real difference outside that known-stripped state still
 *     declines the group into manual review.
 *
 * Usage (inside the project's dev shell):
 *   node scripts/dedupe-character-rows.mjs                      (dry run - reports groups/plans, touches nothing)
 *   node scripts/dedupe-character-rows.mjs --apply              (performs the merge for real)
 *   node scripts/dedupe-character-rows.mjs --apply --group-limit 3   (cap how many groups get applied - smoke test)
 *   node scripts/dedupe-character-rows.mjs --only <avatar-id>   (only process the group containing this id)
 *
 * Safely re-runnable: once a group's losers are deleted, a re-run's own DB query no longer sees them, so that
 * group naturally drops out - no separate checkpoint file needed (same reasoning dedupe-untouched-cards.mjs's
 * header gives for its own re-runnability).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import extract from 'png-chunks-extract';

import { computeContentIdentityHash } from '../src/character-card-normalize.js';
import { computeAvatarIdentityHashFromChunks, readFromChunks } from '../src/character-card-parser.js';

// character-shallow.js reads this config value at module load (getConfigValue() call at its own top level) -
// this script runs standalone, never through server.js's normal setConfigFilePath() bootstrap, so it has to
// supply the value directly. Env vars short-circuit before config.yaml is ever touched (see util.js's
// getConfigValue()). Static `import` statements are hoisted ahead of any other top-level code in an ES module
// (they'd run before the env var below regardless of source order), so this has to be a dynamic import,
// executed after the env var is actually set - same reason tests/dedupe-character-rows.test.js sets it before
// its own `await import()` of this module.
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

/**
 * A character's chat directory is named after its OWN id/filename (see src/endpoints/characters.js:
 * `characterDirectory = avatar_url.replace('.png', '')`) - so every duplicate row, even ones sharing
 * content_identity_hash, has its own independent chats directory. Never assume two rows share one.
 * @param {string} chatsDir
 * @param {string} id
 */
export function getChatDir(chatsDir, id) {
    return path.join(chatsDir, id.replace(/\.png$/, ''));
}

/**
 * Ground-truth chat stats read directly off disk, via the exact same helper the live write path uses
 * (src/character-shallow.js) - deliberately NOT the db's chat_size/date_last_chat columns, which were found to
 * carry phantom/stale values on some duplicate rows in the real library (see this script's header).
 * @param {string} chatsDir
 * @param {string} id
 * @returns {{chatSize: number, dateLastChat: number}}
 */
export function getRealChatStats(chatsDir, id) {
    return calculateChatSize(getChatDir(chatsDir, id));
}

/**
 * Picks the surviving row for one duplicate group. See this script's header for the policy and why it isn't
 * "lowest id wins".
 * @param {CharacterRow[]} group
 * @param {Map<string, {chatSize: number, dateLastChat: number}>} realStatsById
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

/**
 * OR across the whole group - real user-meaningful state, never allowed to be lost.
 * @param {CharacterRow} survivor
 * @param {CharacterRow[]} losers
 * @returns {boolean} true if the survivor's fav needs flipping to 1
 */
export function planFavUpdate(survivor, losers) {
    if (survivor.fav) return false;
    return losers.some(l => !!l.fav);
}

/**
 * Tag ids present on any loser but not already on the survivor - the set that needs to be added to the
 * survivor before its losers are deleted, so no tag association is silently lost. Mirrors
 * renameCharacterRow()'s own union-not-overwrite tag-carry shape (character-metadata-db.js).
 * @param {import('better-sqlite3').Database} db
 * @param {string} survivorId
 * @param {string[]} loserIds
 * @returns {string[]}
 */
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
 * Plans every chat file move needed to fold each loser's REAL chats into the survivor's chat directory before
 * that loser's row (and directory) gets removed. A same-named file already in the survivor's directory is left
 * in place if byte-identical (`skip-duplicate`); if it's genuinely different content it gets a disambiguating
 * suffix rather than ever being silently overwritten - the real "Lucy Liubot" / "Lucy Liubot1" case this script's
 * header describes (two different chats, coincidentally the same byte size).
 * @param {string} chatsDir
 * @param {string} survivorId
 * @param {string[]} loserIds
 * @param {(p: string) => boolean} [exists]
 * @param {(p: string) => string[]} [readdir]
 * @param {(p: string) => Buffer} [readFile]
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
 * Whether a loser's active_chat pointer should be inherited onto the survivor - only when the survivor has no
 * pointer of its own (never clobber a real one) AND the loser's pointer is verified real (its own chat directory
 * actually contains that exact file - a dangling pointer, confirmed to exist in the real library on a "Barbie"
 * duplicate whose pointed-to chat folder didn't exist at all, is never trusted). Returns the post-move chat name
 * (accounting for a possible collision rename from planChatMoves()), or null if nothing should be inherited.
 * @param {CharacterRow} survivor
 * @param {CharacterRow[]} losers
 * @param {ReturnType<typeof planChatMoves>} chatMoves
 * @returns {string|null}
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
 * Verifies a loser's PNG is safe to merge away, by RE-DERIVING both content_identity_hash and
 * avatar_identity_hash live from each file's current on-disk bytes (never trusting the db's cached columns,
 * which is what formed the group in the first place - this is an independent check, not a re-read of the same
 * claim) and requiring both to match the survivor's freshly-computed values.
 *
 * NOT a full-file byte compare - that was tried first and found to decline every real duplicate pair in the
 * owner's library, because two rows sharing content_identity_hash are BY DESIGN expected to differ in exactly
 * the `chat`/`create_date` JSON bytes (content_identity_hash strips those - see this script's header). Between
 * avatar_identity_hash (IDAT/pixel bytes only) and content_identity_hash (everything else minus fav/chat/
 * create_date), any real difference outside that known-stripped state still declines the group.
 * @param {string} charactersDir
 * @param {string} survivorId
 * @param {string} loserId
 * @param {(p: string) => boolean} [exists]
 * @param {(p: string) => Buffer} [readFile]
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

/**
 * Builds the full merge plan for one duplicate group without touching anything - the same plan dry-run reporting
 * and --apply execution both work from, so what gets printed is exactly what would happen.
 * @param {CharacterRow[]} group
 * @param {object} context
 * @param {import('better-sqlite3').Database} context.db
 * @param {string} context.charactersDir
 * @param {string} context.chatsDir
 * @returns {object} plan
 */
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
    // Post-move chat stats: the survivor's own real stats, plus whatever's landing in its directory from losers
    // (skip-duplicate entries contribute nothing new - that content is already counted in the survivor's own dir).
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

/** Mirrors deleteRowSync() in src/character-metadata-db.js exactly (that function isn't exported). */
function deleteCharacterRowSync(db, id) {
    db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    db.prepare('DELETE FROM character_tags WHERE character_id = ?').run(id);
    db.prepare('DELETE FROM local_import_mtimes WHERE duplicate_of = ?').run(id);
    db.prepare('INSERT INTO changes (id, op) VALUES (?, ?)').run(id, 'delete');
}

/**
 * Executes one already-verified (needsReview: false) plan for real: moves chat files, applies fav/tags/
 * active_chat/chat-stats merges onto the survivor, deletes each loser's row, PNG, and (now-empty) chat directory.
 * Wrapped in a single db transaction by the caller so a mid-group failure never leaves partial db state - file
 * moves happen first and are individually safe to re-run (a already-moved file just won't be found a second
 * time), so a failure between the file phase and the db phase is recoverable by re-running the whole script.
 * @param {object} plan
 * @param {import('better-sqlite3').Database} db
 * @param {string} charactersDir
 * @param {string} chatsDir
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
 * @param {boolean} [options.apply]
 * @param {number} [options.groupLimit]
 * @param {string} [options.only] Only process the group containing this id.
 * @param {import('better-sqlite3').Database} options.db
 * @param {string} [options.charactersDir]
 * @param {string} [options.chatsDir]
 * @param {(s: string) => void} [options.log]
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
