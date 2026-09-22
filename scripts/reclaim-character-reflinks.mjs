#!/usr/bin/env node
/**
 * One-off repair: for every already-imported character whose original local-import source is still on
 * disk, converts its stored file from an independent full copy into a reflink sharing extents with
 * that source.
 *
 * Matching: characters.avatar_identity_hash (sha256 over raw IDAT payload bytes, see
 * computeAvatarIdentityHashFromChunks() in character-card-parser.js) against a hash index built by walking
 * localImport.directories. Because the match key is IDAT-only and the reflinked prefix for a source file with
 * no chara/ccv3 chunks of its own is exactly that source's whole pre-IEND byte range (findReflinkablePrefixOffset()
 * in character-card-parser.js), an avatar_identity_hash match already guarantees the prefix is byte-identical -
 * reclaimReflinkPrefix() is called with `skipByteVerification: true` accordingly, so it skips its default
 * full-file Buffer.compare. (content_hash - whole-file, frozen at import time - was tried first and rejected:
 * it isn't backfilled for every row and can be stale relative to a character's current on-disk bytes for any
 * character that had its PNG rewritten by a non-import write path before writeCardToFile() made that
 * image-only/immutable.)
 *
 * local_import_mtimes (character-metadata-db.js) stores source_path for every file the local-import scanner
 * has touched, but only carries a source_path -> character-id link (its duplicate_of column) for a source file
 * the scanner matched to an ALREADY-imported character on a later pass - not for an ordinary first-time import,
 * which is the majority case here. So it can't replace the full source-directory hash index below for most
 * rows as-is; using it would need either reversing that lookup some other way or backfilling duplicate_of
 * for first imports too - left as a follow-up, not attempted here.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/reclaim-character-reflinks.mjs             (dry run - reports matches, touches nothing)
 *   node scripts/reclaim-character-reflinks.mjs --apply      (performs the reflink swap for real matches)
 *   node scripts/reclaim-character-reflinks.mjs --apply --limit 500   (cap how many source files get
 *       hashed while building the index - for a quick smoke test, not a real run)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import yaml from 'yaml';

import { reclaimReflinkPrefix, computeAvatarIdentityHashFromImageBuffer } from '../src/character-card-parser.js';
import { mapWithConcurrency } from '../src/util.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml');

// Bounded, not maximized: this is I/O-bound work sharing a disk with the live dev server.
const APPLY_CONCURRENCY = 8;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const HASH_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

function hashImageFile(filePath) {
    return fs.promises.readFile(filePath).then(buf => computeAvatarIdentityHashFromImageBuffer(buf));
}

async function buildSourceHashIndex(directories) {
    const index = new Map();
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
                const hash = await hashImageFile(filePath);
                if (!index.has(hash)) index.set(hash, filePath);
            } catch (error) {
                console.warn(`  skip (unreadable): ${filePath} - ${/** @type {any} */ (error)?.message ?? error}`);
            }
            scanned++;
            if (scanned % 5000 === 0) {
                const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
                console.log(`  hashed ${scanned} source files so far (${elapsedSec}s elapsed)...`);
            }
        }
    }

    console.log(`Source hash index built: ${index.size} unique-image files from ${scanned} scanned, across ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}.`);
    return index;
}

async function main() {
    if (!fs.existsSync(CONFIG_PATH)) {
        throw new Error(`Config not found at ${CONFIG_PATH} - run this from the repo root.`);
    }
    const config = yaml.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const directories = config?.localImport?.directories ?? [];
    if (directories.length === 0) {
        throw new Error('No localImport.directories configured in config.yaml - nothing to match candidates against.');
    }

    console.log(`Mode: ${APPLY ? 'APPLY (files will be modified in place)' : 'DRY RUN (no files touched - pass --apply to perform the reclaim)'}`);
    console.log(`Source directories: ${directories.join(', ')}`);
    if (Number.isFinite(HASH_LIMIT)) {
        console.log(`Hash index capped at ${HASH_LIMIT} source files (--limit) - smoke-test mode, not a real full run.`);
    }
    console.log('');

    const hashIndex = await buildSourceHashIndex(directories);

    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare('SELECT id, avatar_identity_hash FROM characters WHERE avatar_identity_hash IS NOT NULL').all();
    db.close();
    console.log(`${rows.length} character rows carry an avatar_identity_hash to check against the index.`);
    console.log('');

    let missingFile = 0;
    let noSourceMatch = 0;
    /** @type {{id: string, existingPath: string, sourcePath: string}[]} */
    const candidates = [];

    for (const row of rows) {
        const existingPath = path.join(CHARACTERS_DIR, row.id);
        if (!fs.existsSync(existingPath)) {
            missingFile++;
            continue;
        }

        const sourcePath = hashIndex.get(row.avatar_identity_hash);
        if (!sourcePath) {
            noSourceMatch++;
            continue;
        }

        candidates.push({ id: row.id, existingPath, sourcePath });
    }

    console.log(`rows with avatar_identity_hash:      ${rows.length}`);
    console.log(`  missing character file (skipped):  ${missingFile}`);
    console.log(`  no matching source found (skipped): ${noSourceMatch}`);
    console.log(`  matched to a still-present source:  ${candidates.length}`);

    if (!APPLY) {
        console.log('');
        console.log('(dry run only - re-run with --apply to actually perform the reflink swap)');
        return;
    }

    let reflinked = 0;
    let declined = 0;
    let errors = 0;
    let processed = 0;

    await mapWithConcurrency(candidates, APPLY_CONCURRENCY, async (candidate) => {
        try {
            const result = await reclaimReflinkPrefix(candidate.existingPath, candidate.sourcePath, { skipByteVerification: true });
            if (result.reflinked) {
                reflinked++;
            } else {
                declined++;
                console.log(`  declined: ${candidate.id} (${result.reason})`);
            }
        } catch (error) {
            errors++;
            console.warn(`  error: ${candidate.id} - ${/** @type {any} */ (error)?.message ?? error}`);
        }

        processed++;
        if (processed % 1000 === 0) {
            console.log(`  ...${processed}/${candidates.length} candidates processed so far (${reflinked} reflinked)`);
        }
    });

    console.log('');
    console.log('--- summary ---');
    console.log(`rows with avatar_identity_hash:      ${rows.length}`);
    console.log(`  missing character file (skipped):  ${missingFile}`);
    console.log(`  no matching source found (skipped): ${noSourceMatch}`);
    console.log(`  matched to a still-present source:  ${candidates.length}`);
    console.log(`    reflinked:                        ${reflinked}`);
    console.log(`    declined (verification failed):   ${declined}`);
    console.log(`    errors:                            ${errors}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
