#!/usr/bin/env node
/**
 * One-time backfill for `characters.avatar_identity_hash` on rows that predate the column.
 * Safe to run against a live server: read-then-conditional-write per row (`WHERE avatar_identity_hash IS NULL`),
 * so a concurrent live write for the same row wins over this script's stale computation.
 *
 * Usage (from repo root):
 *   node scripts/backfill-avatar-identity-hashes.mjs              (dry run)
 *   node scripts/backfill-avatar-identity-hashes.mjs --apply
 *   node scripts/backfill-avatar-identity-hashes.mjs --apply --limit 500   (smoke test)
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
            // Zero rows matched: a concurrent live write already set a real value for this id; that wins.
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
