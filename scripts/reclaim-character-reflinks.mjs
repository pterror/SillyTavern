#!/usr/bin/env node
/**
 * One-off repair: for every already-imported character whose original local-import source is still on
 * disk, retroactively converts its stored file from an independent full copy into a reflink sharing
 * extents with that source - reclaiming the disk space local-import's staging reflink
 * (copyCharacterFile()) already avoided consuming, but that the metadata-embed write step (before
 * writeCardToFile() existed - see character-card-parser.js) silently paid anyway, once per import.
 *
 * Matching: characters.content_hash (populated for local-import's format importers) is the sha256 of the
 * raw original source bytes - matched here against a hash index built by walking the configured
 * localImport.directories once. A match is a CANDIDATE only; reclaimReflinkPrefix() independently
 * verifies the shared byte prefix before touching anything, so a wrong/stale match is simply declined,
 * never guessed past.
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

import { reclaimReflinkPrefix } from '../src/character-card-parser.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.yaml');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const HASH_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

/**
 * @param {string} filePath
 * @returns {Promise<string>} sha256 hex digest, streamed (not buffered whole) so this scales to a
 * multi-hundred-GB corpus without holding every file in memory at once.
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
 * @param {string[]} directories
 * @returns {Promise<Map<string, string>>} sha256 hex -> absolute source file path
 */
async function buildSourceHashIndex(directories) {
    /** @type {Map<string, string>} */
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
                const hash = await sha256File(filePath);
                // First path wins on a hash collision across configured directories - doesn't matter
                // which, since a real collision here means byte-identical source files anyway.
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

    console.log(`Source hash index built: ${index.size} unique-content files from ${scanned} scanned, across ${directories.length} director${directories.length === 1 ? 'y' : 'ies'}.`);
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
    const rows = db.prepare('SELECT id, content_hash FROM characters WHERE content_hash IS NOT NULL').all();
    db.close();
    console.log(`${rows.length} character rows carry a content_hash to check against the index.`);
    console.log('');

    let matched = 0;
    let reflinked = 0;
    let declined = 0;
    let errors = 0;
    let missingFile = 0;
    let noSourceMatch = 0;

    for (const row of rows) {
        const existingPath = path.join(CHARACTERS_DIR, row.id);
        if (!fs.existsSync(existingPath)) {
            missingFile++;
            continue;
        }

        const sourcePath = hashIndex.get(row.content_hash);
        if (!sourcePath) {
            noSourceMatch++;
            continue;
        }

        matched++;
        if (!APPLY) continue;

        try {
            const result = await reclaimReflinkPrefix(existingPath, sourcePath);
            if (result.reflinked) {
                reflinked++;
            } else {
                declined++;
                console.log(`  declined: ${row.id} (${result.reason})`);
            }
        } catch (error) {
            errors++;
            console.warn(`  error: ${row.id} - ${/** @type {any} */ (error)?.message ?? error}`);
        }

        const processed = reflinked + declined + errors;
        if (processed > 0 && processed % 1000 === 0) {
            console.log(`  ...${processed}/${matched} candidates processed so far (${reflinked} reflinked)`);
        }
    }

    console.log('');
    console.log('--- summary ---');
    console.log(`rows with content_hash:              ${rows.length}`);
    console.log(`  missing character file (skipped):  ${missingFile}`);
    console.log(`  no matching source found (skipped): ${noSourceMatch}`);
    console.log(`  matched to a still-present source:  ${matched}`);
    if (APPLY) {
        console.log(`    reflinked:                        ${reflinked}`);
        console.log(`    declined (verification failed):   ${declined}`);
        console.log(`    errors:                            ${errors}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually perform the reflink swap)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
