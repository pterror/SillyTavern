#!/usr/bin/env node
/**
 * One-off corpus-wide correction: for every character row whose content_hash still matches a file
 * currently present in one of `localImport.directories`, sets characters.date_added (and shallow_json's
 * own embedded date_added field) to that source file's mtime, replacing whatever date_added the row
 * already carries (import-time "now", or a stale ctimeMs from an old bootstrap).
 *
 * Matching: content_hash (sha256 of the raw source bytes, populated for local-import's format importers)
 * against a hash index built by walking the configured directories once - the same shape
 * reclaim-character-reflinks.mjs already uses for the identical "match a live row back to its original
 * external source file" problem. There is no cheaper join available: nothing in this database records
 * which source path an ORIGINAL (non-duplicate) import came from, only the byte content does, so hashing
 * every configured-directory file is the only correct way to recover that link - matching by name or mtime
 * proximity would just be guessing which character a file belongs to. A source file's mtime is only ever
 * read, never written.
 *
 * Per-file hashes are cached to disk (HASH_CACHE_PATH, keyed by path + the mtimeMs they were computed
 * against) and reused on a later run for any file whose mtime hasn't changed - so a dry run followed by
 * --apply, or a re-run after an interruption, never re-hashes a file it already has a good answer for.
 *
 * SAFE TO INTERRUPT: this script writes nothing until --apply, and even then every row's UPDATE is a
 * compare-and-swap on the exact date_added value this script itself just read for that row -
 * `WHERE id = @id AND date_added = @expectedOldDateAdded` - so a concurrent write to the same row (a
 * live rename, a fresh reimport) simply wins and this script's own now-stale value is discarded, never
 * forced over it. Killing the process at any point leaves the database in a state no different from
 * having processed however many rows it got through; every following invocation only ever touches rows
 * whose stored date_added still differs from the source file's mtime, so re-running after an interruption
 * (or just to pick up newly-added source files) is always correct and just skips whatever already matches.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/backfill-date-added-from-source-mtime.mjs              (dry run - reports what WOULD change, touches nothing)
 *   node scripts/backfill-date-added-from-source-mtime.mjs --apply       (performs the correction for real)
 *   node scripts/backfill-date-added-from-source-mtime.mjs --apply --limit 500   (cap how many source files
 *       get hashed while building the index - for a quick smoke test, not a real run)
 *   node scripts/backfill-date-added-from-source-mtime.mjs --sample 20   (dry run, print this many example
 *       rows that WOULD change instead of the default 10 - for manual verification before --apply)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import yaml from 'yaml';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml');
// Per-file (path, mtimeMs) -> hash cache, persisted across invocations - hashing the full configured
// corpus is the expensive part of this script (a full read of every source file), and a dry run followed
// by the real --apply run would otherwise pay that cost twice for identical, unchanged files. Keyed by
// path with the mtimeMs it was computed against, so a file that changed on disk since the last run is
// transparently re-hashed rather than served a stale answer.
const HASH_CACHE_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, '.backfill-date-added-source-hash-cache.json');
const HASH_CACHE_SAVE_INTERVAL = 20000;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const HASH_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;
const sampleArgIndex = args.indexOf('--sample');
const SAMPLE_SIZE = sampleArgIndex !== -1 ? Number(args[sampleArgIndex + 1]) : 10;

/**
 * @param {string} filePath
 * @returns {Promise<string>} sha256 hex digest, streamed so this scales to a multi-hundred-GB corpus
 * without holding any file in memory whole.
 */
function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * @param {string} shallowJson
 * @param {number} dateAddedMs
 * @returns {string} `shallowJson` with its date_added field overwritten - unmodified if it doesn't parse.
 */
function withPatchedDateAdded(shallowJson, dateAddedMs) {
    try {
        const parsed = JSON.parse(shallowJson);
        parsed.date_added = dateAddedMs;
        return JSON.stringify(parsed);
    } catch {
        return shallowJson;
    }
}

/**
 * @returns {Map<string, {mtimeMs: number, hash: string}>} path -> the (mtimeMs, hash) it was last seen with -
 * empty if the cache file doesn't exist yet or fails to parse (a corrupt/foreign cache is just discarded, never
 * fatal - worst case is re-hashing everything, same as no cache at all).
 */
function loadHashCache() {
    try {
        const parsed = JSON.parse(fs.readFileSync(HASH_CACHE_PATH, 'utf8'));
        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

/**
 * @param {Map<string, {mtimeMs: number, hash: string}>} cache
 */
function saveHashCache(cache) {
    fs.mkdirSync(path.dirname(HASH_CACHE_PATH), { recursive: true });
    fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(Object.fromEntries(cache)));
}

/**
 * @param {string[]} directories
 * @returns {Promise<Map<string, {mtimeMs: number, sourcePath: string}>>} sha256 hex -> source file's mtime + path
 */
async function buildSourceIndex(directories) {
    /** @type {Map<string, {mtimeMs: number, sourcePath: string}>} */
    const index = new Map();
    const hashCache = loadHashCache();
    let cacheHits = 0;
    let scanned = 0;
    const startedAt = Date.now();

    outer:
    for (const dir of directories) {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (scanned >= HASH_LIMIT) break outer;
            const filePath = path.join(dir, entry.name);
            try {
                const stat = await fs.promises.stat(filePath);
                const cached = hashCache.get(filePath);
                let hash;
                if (cached && cached.mtimeMs === stat.mtimeMs) {
                    hash = cached.hash;
                    cacheHits++;
                } else {
                    hash = await sha256File(filePath);
                    hashCache.set(filePath, { mtimeMs: stat.mtimeMs, hash });
                }
                // First path wins on a hash collision across configured directories - a real collision here
                // means byte-identical source files anyway, so either one's mtime is an equally valid answer.
                if (!index.has(hash)) index.set(hash, { mtimeMs: stat.mtimeMs, sourcePath: filePath });
            } catch (error) {
                console.warn(`  skip (unreadable): ${filePath} - ${/** @type {any} */ (error)?.message ?? error}`);
            }
            scanned++;
            if (scanned % 5000 === 0) {
                const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
                console.log(`  hashed ${scanned} source files so far (${elapsedSec}s elapsed, ${cacheHits} served from cache)...`);
            }
            if (scanned % HASH_CACHE_SAVE_INTERVAL === 0) saveHashCache(hashCache);
        }
    }

    saveHashCache(hashCache);
    console.log(`Source index built: ${index.size} unique-content files from ${scanned} scanned (${cacheHits} served from cache), across ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}.`);
    return index;
}

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`No metadata store found at ${DB_PATH} - run this from the repo root, on an install that has already bootstrapped its character-metadata.sqlite.`);
    }
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Config not found at ${CONFIG_PATH} - run this from the repo root.`);
    }
    const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const directories = config?.localImport?.directories ?? [];
    if (directories.length === 0) {
        throw new Error('No localImport.directories configured in config.yaml - nothing to match rows against.');
    }

    console.log(`Mode: ${APPLY ? 'APPLY (date_added will be written for real)' : 'DRY RUN (no rows touched - pass --apply to perform the backfill)'}`);
    console.log(`Source directories: ${directories.join(', ')}`);
    if (Number.isFinite(HASH_LIMIT)) {
        console.log(`Hash index capped at ${HASH_LIMIT} source files (--limit) - smoke-test mode, not a real full run.`);
    }
    console.log('');

    const sourceIndex = await buildSourceIndex(directories);

    // WAL (already the live server's own journal mode) + a real busy_timeout so a momentary lock held by
    // the live server's own writer is waited out rather than surfaced as a hard error - opened read-write
    // even in dry-run mode (nothing is actually written unless APPLY), so pragma-setting itself never fails
    // against a readonly handle.
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');

    const rows = db.prepare('SELECT id, content_hash, date_added, shallow_json FROM characters WHERE content_hash IS NOT NULL').all();
    console.log(`${rows.length} character rows carry a content_hash to check against the index.`);
    console.log('');

    let candidates = 0;
    let unchanged = 0;
    let noSourceMatch = 0;
    let written = 0;
    let staleSkipped = 0;
    const samples = [];

    const updateStmt = db.prepare(
        'UPDATE characters SET date_added = @newDateAdded, shallow_json = @shallowJson WHERE id = @id AND date_added = @oldDateAdded',
    );

    for (const row of rows) {
        const match = sourceIndex.get(row.content_hash);
        if (!match) {
            noSourceMatch++;
            continue;
        }

        const oldDateAdded = Number(row.date_added);
        const newDateAdded = Math.round(match.mtimeMs);
        if (oldDateAdded === newDateAdded) {
            unchanged++;
            continue;
        }

        candidates++;
        if (samples.length < SAMPLE_SIZE) {
            samples.push({
                id: row.id,
                sourcePath: match.sourcePath,
                oldDateAdded: new Date(oldDateAdded).toISOString(),
                newDateAdded: new Date(newDateAdded).toISOString(),
            });
        }

        if (!APPLY) continue;

        const shallowJson = withPatchedDateAdded(row.shallow_json, newDateAdded);
        const result = updateStmt.run({ id: row.id, newDateAdded, shallowJson, oldDateAdded });
        if (result.changes > 0) {
            written++;
        } else {
            // The CAS guard matched zero rows - a concurrent write to this exact id landed between this
            // script's SELECT and this UPDATE and already changed date_added out from under it. That live
            // value wins; this script's own (necessarily stale) computation is correctly discarded, not
            // forced over it. A following run will re-evaluate this row fresh.
            staleSkipped++;
        }

        const processed = written + staleSkipped;
        if (processed > 0 && processed % 5000 === 0) {
            console.log(`  ...${processed}/${candidates} candidates processed so far (${written} written)`);
        }
    }

    db.close();

    console.log('');
    console.log('--- sample rows that would change (verify these before --apply) ---');
    for (const sample of samples) {
        console.log(`  ${sample.id}: ${sample.oldDateAdded} -> ${sample.newDateAdded}  (source: ${sample.sourcePath})`);
    }
    if (samples.length === 0) console.log('  (none)');

    console.log('');
    console.log('--- summary ---');
    console.log(`rows with content_hash:                 ${rows.length}`);
    console.log(`  no matching source found (skipped):   ${noSourceMatch}`);
    console.log(`  already correct (skipped):            ${unchanged}`);
    console.log(`  candidates for correction:             ${candidates}`);
    if (APPLY) {
        console.log(`    written:                             ${written}`);
        console.log(`    stale (changed concurrently, skipped): ${staleSkipped}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually write date_added)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
