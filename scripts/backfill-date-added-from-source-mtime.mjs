#!/usr/bin/env node
/**
 * Corrects characters.date_added (and shallow_json's embedded date_added) to the source file's mtime,
 * for any row whose content_hash still matches a file under `localImport.directories`.
 *
 * Matches rows to source files by content_hash against a hash index built by walking the configured
 * directories, since nothing else records which source path an import came from.
 *
 * Writes (under --apply) are compare-and-swap on the date_added this script read, so a concurrent live
 * write to the same row wins and is never clobbered. Safe to interrupt and re-run at any point.
 *
 * Usage (from repo root):
 *   node scripts/backfill-date-added-from-source-mtime.mjs              (dry run)
 *   node scripts/backfill-date-added-from-source-mtime.mjs --apply
 *   node scripts/backfill-date-added-from-source-mtime.mjs --apply --limit 500   (smoke test)
 *   node scripts/backfill-date-added-from-source-mtime.mjs --sample 20   (print more example rows)
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
// Keyed by path + mtimeMs, so a dry run followed by --apply doesn't re-hash unchanged files.
const HASH_CACHE_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, '.backfill-date-added-source-hash-cache.json');
const HASH_CACHE_SAVE_INTERVAL = 20000;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const HASH_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;
const sampleArgIndex = args.indexOf('--sample');
const SAMPLE_SIZE = sampleArgIndex !== -1 ? Number(args[sampleArgIndex + 1]) : 10;

/**
 * @returns {Promise<string>} sha256 hex digest
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
 * @returns {string} `shallowJson` with date_added overwritten; unmodified if it doesn't parse.
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
 * @returns {Map<string, {mtimeMs: number, hash: string}>} empty if the cache file is missing or corrupt.
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
                // First path wins on a hash collision - byte-identical files anyway.
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
            // CAS guard matched zero rows: a concurrent write already changed this row; that wins.
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
