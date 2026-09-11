#!/usr/bin/env node
/**
 * One-time corpus-wide backfill for `characters.card_json` (see character-metadata-db.js's SCHEMA_SQL comment
 * on that column) - by design that column is only ever written lazily, by a metadata-only edit (characters.js's
 * writeCharacterData()), so on a preexisting library it stays NULL for every row nobody has edited yet, and
 * every read of those rows (readCardContent()) falls through to a PNG tEXt-chunk parse. This script eagerly
 * populates it for the rest of the library too, so a read never has to open a PNG for a row this script has
 * touched - purely a read-latency trade (more SQLite text, no more PNG parses on the hot path), never a
 * correctness change: NULL still means exactly what it always has ("read the PNG"), and any row this script
 * writes still gets correctly invalidated back to NULL the next time its PNG is genuinely observed changing,
 * because handleWatchEvent()/reconcile() (character-metadata-db.js) call buildRow() with no `cardJson` argument
 * at all - it defaults to `null` - on every mtime-mismatch rebuild, regardless of whether this script ever
 * touched that row. See that column's own SCHEMA_SQL comment for the full NULL-is-load-bearing invariant this
 * script deliberately never disturbs.
 *
 * LIVE-SERVER SAFETY (same posture as scripts/backfill-avatar-identity-hashes.mjs - read this repo's own
 * harness notes on always checking for a live server first): read-then-conditional-write per row, never a
 * blind bulk UPDATE or a single wrapping transaction spanning many rows. Each row's own UPDATE is guarded by
 * `WHERE card_json IS NULL AND file_mtime = @fileMtime` - if the live server's own write path (an edit, a
 * local-import overwrite, the watcher/reconciler observing an external change) touches this SAME row between
 * this script's read and its write, `file_mtime` no longer matches what this script read the file at, so the
 * guard fails and this script's own (now-stale) parse is silently discarded instead of clobbering whatever the
 * live server just did. `PRAGMA busy_timeout` is set so a momentary write-lock held by the live server's own
 * writer is waited out rather than surfaced as a hard error. This script never touches the character PNG files
 * themselves - read-only there, always.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/backfill-card-json.mjs              (dry run - reports what WOULD be written, touches nothing)
 *   node scripts/backfill-card-json.mjs --apply       (performs the backfill for real)
 *   node scripts/backfill-card-json.mjs --apply --limit 500   (cap how many rows get processed -
 *       for a quick smoke test, not a real run)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { parse } from '../src/character-card-parser.js';

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

    console.log(`Mode: ${APPLY ? 'APPLY (card_json will be written for real)' : 'DRY RUN (no rows touched - pass --apply to perform the backfill)'}`);
    if (Number.isFinite(ROW_LIMIT)) {
        console.log(`Row count capped at ${ROW_LIMIT} (--limit) - smoke-test mode, not a real run.`);
    }
    console.log('');

    // WAL mode (already the live server's own journal mode, see sqlite-engine.js) plus a real busy_timeout so
    // a momentary lock held by the live server's own writer is waited out rather than thrown as SQLITE_BUSY.
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');

    const selectStmt = db.prepare('SELECT id, file_mtime FROM characters WHERE card_json IS NULL LIMIT @limit');
    const updateStmt = db.prepare('UPDATE characters SET card_json = @cardJson WHERE id = @id AND card_json IS NULL AND file_mtime = @fileMtime');

    const rows = selectStmt.all({ limit: Number.isFinite(ROW_LIMIT) ? ROW_LIMIT : -1 });
    console.log(`${rows.length} row(s) currently missing card_json.`);
    console.log('');

    let parsed = 0;
    let written = 0;
    let staleSkipped = 0;
    let missingFile = 0;
    let unreadable = 0;

    for (const row of rows) {
        const filePath = path.join(CHARACTERS_DIR, row.id);
        if (!fs.existsSync(filePath)) {
            missingFile++;
            continue;
        }

        // Stat first, not just a try/catch around parse(): a mismatch here means the file has moved on since
        // this row was last observed (a write in flight, or a change not yet reconciled), so parsing it now
        // would produce content that doesn't match `file_mtime` anyway - skip it exactly like the UPDATE
        // guard below would, just without paying for the parse first.
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs !== Number(row.file_mtime)) {
            staleSkipped++;
            continue;
        }

        let cardJson;
        try {
            cardJson = await parse(filePath, 'png');
        } catch (error) {
            unreadable++;
            console.warn(`  unreadable: ${row.id} - ${/** @type {any} */ (error)?.message ?? error}`);
            continue;
        }
        if (cardJson === undefined) {
            unreadable++;
            continue;
        }
        parsed++;

        if (!APPLY) continue;

        const result = updateStmt.run({ id: row.id, cardJson, fileMtime: row.file_mtime });
        if (result.changes > 0) {
            written++;
        } else {
            // Either the row's card_json got set by a concurrent metadata-only edit, or its file_mtime moved
            // (an external write landed) between this script's SELECT and this UPDATE - either way, that live
            // write wins over this script's now-stale read, exactly like avatar_identity_hash's own backfill.
            staleSkipped++;
        }

        const processed = written + staleSkipped + unreadable;
        if (processed > 0 && processed % 5000 === 0) {
            console.log(`  ...${processed}/${rows.length} rows processed so far (${written} written)`);
        }
    }

    db.close();

    console.log('');
    console.log('--- summary ---');
    console.log(`rows missing card_json:                  ${rows.length}`);
    console.log(`  missing character file (skipped):      ${missingFile}`);
    console.log(`  stale mtime / concurrent write (skipped): ${staleSkipped}`);
    console.log(`  unreadable/unparseable PNG (skipped):  ${unreadable}`);
    console.log(`  card_json parsed:                      ${parsed}`);
    if (APPLY) {
        console.log(`    written:                             ${written}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually write card_json)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
