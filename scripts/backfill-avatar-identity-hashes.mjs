#!/usr/bin/env node
/**
 * One-time corpus-wide backfill for `characters.avatar_identity_hash` (see character-metadata-db.js's
 * SCHEMA_SQL comment on that column) - every row that existed before this column was added has it NULL, and
 * nothing else in this codebase ever goes back and fills in an OLD row's value (upsertCharacterFromWrite()
 * only ever sets it on a fresh write - see that function's own doc comment). Without this script, an install's
 * entire preexisting library stays permanently unable to participate in the avatar-identity half of
 * local-import-scan.js's dedup-skip check or any future avatar-identity consumer.
 *
 * Computes computeAvatarIdentityHashFromChunks() (character-card-parser.js) - sha256 over each character's own
 * PNG's concatenated raw IDAT chunk payload bytes - directly from the file currently on disk. Unlike
 * content_identity_hash's own backfillContentIdentityHashes() (character-metadata-db.js, boot-time, poisoned
 * rows only), there is no "recover the pristine pre-mutation value" concern here: a row's PNG pixel bytes were
 * never touched by the JSON-mutation bug that made content_identity_hash need pristine-chunk recovery in the
 * first place (that bug only ever rewrote the embedded chara/ccv3 TEXT, never the IDAT chunk) - so every row's
 * CURRENT on-disk avatar bytes are exactly what this hash should reflect, poisoned or not.
 *
 * LIVE-SERVER SAFETY (this install's local-import pipeline may be actively running against real data while
 * this script runs - see this repo's own harness notes on always checking for that first): read-then-
 * conditional-write per row, never a blind bulk UPDATE or a single wrapping transaction spanning many rows
 * (same posture as reclaimReflinkPrefix()'s own per-row loop below, and as this module's SCHEMA_SQL comment on
 * avatar_identity_hash describes). Each row's own UPDATE is guarded by `WHERE avatar_identity_hash IS NULL`,
 * so if the live server's own upsertCharacterFromWrite() sets a real value for that SAME row between this
 * script's read and its write (a concurrent edit/reimport/rename), that write simply wins - this script's own
 * stale computation is silently discarded instead of clobbering it. `PRAGMA busy_timeout` is set so a momentary
 * write-lock held by the live server's own writer is waited out rather than surfaced as a hard error. This
 * script never touches the character PNG files themselves - read-only there, always.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/backfill-avatar-identity-hashes.mjs              (dry run - reports what WOULD be written, touches nothing)
 *   node scripts/backfill-avatar-identity-hashes.mjs --apply       (performs the backfill for real)
 *   node scripts/backfill-avatar-identity-hashes.mjs --apply --limit 500   (cap how many rows get processed -
 *       for a quick smoke test, not a real run)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import extract from 'png-chunks-extract';

import { computeAvatarIdentityHashFromChunks } from '../src/character-card-parser.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const ROW_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`No metadata store found at ${DB_PATH} - run this from the repo root, on an install that has already bootstrapped its character-metadata.sqlite.`);
    }

    console.log(`Mode: ${APPLY ? 'APPLY (avatar_identity_hash will be written for real)' : 'DRY RUN (no rows touched - pass --apply to perform the backfill)'}`);
    if (Number.isFinite(ROW_LIMIT)) {
        console.log(`Row count capped at ${ROW_LIMIT} (--limit) - smoke-test mode, not a real run.`);
    }
    console.log('');

    // Opened read-write (not the readonly mode reclaim-character-reflinks.mjs uses, since this script's whole
    // job is writing this one column back) - WAL mode (already the live server's own journal mode, see
    // sqlite-engine.js) plus a real busy_timeout so a momentary lock held by the live server's own writer is
    // waited out rather than thrown as SQLITE_BUSY.
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');

    const selectStmt = db.prepare('SELECT id FROM characters WHERE avatar_identity_hash IS NULL LIMIT @limit');
    const updateStmt = db.prepare('UPDATE characters SET avatar_identity_hash = @hash WHERE id = @id AND avatar_identity_hash IS NULL');

    const rows = selectStmt.all({ limit: Number.isFinite(ROW_LIMIT) ? ROW_LIMIT : -1 });
    console.log(`${rows.length} row(s) currently missing avatar_identity_hash.`);
    console.log('');

    let hashed = 0;
    let written = 0;
    let alreadySetByLiveWrite = 0;
    let missingFile = 0;
    let unreadable = 0;

    for (const row of rows) {
        const filePath = path.join(CHARACTERS_DIR, row.id);
        if (!fs.existsSync(filePath)) {
            missingFile++;
            continue;
        }

        let hash;
        try {
            const buf = fs.readFileSync(filePath);
            hash = computeAvatarIdentityHashFromChunks(extract(new Uint8Array(buf)));
        } catch (error) {
            unreadable++;
            console.warn(`  unreadable: ${row.id} - ${/** @type {any} */ (error)?.message ?? error}`);
            continue;
        }
        hashed++;

        if (!APPLY) continue;

        const result = updateStmt.run({ id: row.id, hash });
        if (result.changes > 0) {
            written++;
        } else {
            // The `WHERE avatar_identity_hash IS NULL` guard matched zero rows - a live write for this exact
            // id landed between this script's SELECT and this UPDATE and already set a real value. That live
            // value wins; this script's own (necessarily stale, since it read the file before that write
            // happened) computation is correctly discarded here, not forced over it.
            alreadySetByLiveWrite++;
        }

        const processed = written + alreadySetByLiveWrite + unreadable;
        if (processed > 0 && processed % 5000 === 0) {
            console.log(`  ...${processed}/${rows.length} rows processed so far (${written} written)`);
        }
    }

    db.close();

    console.log('');
    console.log('--- summary ---');
    console.log(`rows missing avatar_identity_hash:        ${rows.length}`);
    console.log(`  missing character file (skipped):       ${missingFile}`);
    console.log(`  unreadable/unparseable PNG (skipped):    ${unreadable}`);
    console.log(`  hash computed:                           ${hashed}`);
    if (APPLY) {
        console.log(`    written:                               ${written}`);
        console.log(`    already set by a concurrent live write: ${alreadySetByLiveWrite}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually write avatar_identity_hash)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
