#!/usr/bin/env node
/**
 * Retroactive sweep: reflinks existing, untouched characters against each other whenever they're
 * semantically identical (matching content_identity_hash). The live write path only reflinks at the
 * moment of a new write, so two byte-independent copies already on disk that nobody touches again never
 * get that chance - this script is the backward look over the whole existing corpus. Safely re-runnable.
 *
 * content_identity_hash groups rows as CANDIDATES only (fav/chat/create_date stripped before hashing);
 * reclaimReflinkPrefix() independently verifies the actual shared byte prefix, including the portrait,
 * before touching anything.
 *
 * Usage (from repo root):
 *   node scripts/dedupe-untouched-cards.mjs                  (dry run)
 *   node scripts/dedupe-untouched-cards.mjs --apply
 *   node scripts/dedupe-untouched-cards.mjs --apply --limit 500   (smoke test)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { reclaimReflinkPrefix } from '../src/character-card-parser.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');

/**
 * @typedef {object} CharacterRow
 * @property {string} id Avatar filename, e.g. "Alice.png"
 * @property {string} content_identity_hash
 * @property {string | null} avatar_identity_hash
 */

/**
 * Groups rows by content_identity_hash, picks a stable source (lowest id) per group, and proposes every
 * other member as a candidate to reflink against it.
 * @returns {{ source: CharacterRow, candidate: CharacterRow }[]}
 */
export function buildReflinkCandidatePairs(rows) {
    /** @type {Map<string, CharacterRow[]>} */
    const groups = new Map();
    for (const row of rows) {
        if (!row.content_identity_hash) continue;
        const group = groups.get(row.content_identity_hash);
        if (group) {
            group.push(row);
        } else {
            groups.set(row.content_identity_hash, [row]);
        }
    }

    /** @type {{ source: CharacterRow, candidate: CharacterRow }[]} */
    const pairs = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
        const [source, ...rest] = sorted;
        for (const candidate of rest) {
            pairs.push({ source, candidate });
        }
    }
    return pairs;
}

/**
 * Cheap prefilter only, not a safety requirement - reclaimReflinkPrefix() still does its own verification.
 * Skips a pair upfront when both rows have a non-null avatar_identity_hash that disagrees, avoiding file
 * reads for a doomed pair.
 * @returns {boolean}
 */
export function isKnownAvatarMismatch(source, candidate) {
    return Boolean(source.avatar_identity_hash) && Boolean(candidate.avatar_identity_hash)
        && source.avatar_identity_hash !== candidate.avatar_identity_hash;
}

/**
 * Runs the sweep over an already-loaded list of character rows, reflinking (or, in dry-run mode, merely
 * reporting) every candidate pair whose files still exist on disk.
 * @param {CharacterRow[]} rows All rows carrying a content_identity_hash.
 * @param {object} [options]
 * @param {(existingPath: string, sourcePath: string) => Promise<{reflinked: boolean, reason?: string}>} [options.reclaim]
 * @returns {Promise<{groups: number, pairs: number, missingFile: number, skippedAvatarMismatch: number,
 * reflinked: number, declined: number, errors: number}>}
 */
export async function runDedupeSweep(rows, options = {}) {
    const {
        charactersDir = CHARACTERS_DIR,
        apply = false,
        limit = Infinity,
        reclaim = reclaimReflinkPrefix,
        exists = fs.existsSync,
    } = options;

    const allPairs = buildReflinkCandidatePairs(rows);
    const groupCount = new Set(allPairs.map(({ source }) => source.content_identity_hash)).size;

    const counters = {
        groups: groupCount,
        pairs: allPairs.length,
        missingFile: 0,
        skippedAvatarMismatch: 0,
        reflinked: 0,
        declined: 0,
        errors: 0,
    };

    let processed = 0;
    for (const { source, candidate } of allPairs) {
        if (processed >= limit) break;

        const candidatePath = path.join(charactersDir, candidate.id);
        if (!exists(candidatePath)) {
            counters.missingFile++;
            continue;
        }

        if (isKnownAvatarMismatch(source, candidate)) {
            counters.skippedAvatarMismatch++;
            continue;
        }

        const sourcePath = path.join(charactersDir, source.id);
        if (!exists(sourcePath)) {
            counters.missingFile++;
            continue;
        }

        processed++;
        if (!apply) continue;

        try {
            const result = await reclaim(candidatePath, sourcePath);
            if (result.reflinked) {
                counters.reflinked++;
            } else {
                counters.declined++;
                console.log(`  declined: ${candidate.id} <- ${source.id} (${result.reason})`);
            }
        } catch (error) {
            counters.errors++;
            console.warn(`  error: ${candidate.id} <- ${source.id} - ${/** @type {any} */ (error)?.message ?? error}`);
        }
    }

    return counters;
}

async function main() {
    const args = process.argv.slice(2);
    const APPLY = args.includes('--apply');
    const limitArgIndex = args.indexOf('--limit');
    const LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

    console.log(`Mode: ${APPLY ? 'APPLY (files will be modified in place)' : 'DRY RUN (no files touched - pass --apply to perform the reflink swap)'}`);
    if (Number.isFinite(LIMIT)) {
        console.log(`Candidate pairs capped at ${LIMIT} (--limit) - smoke-test mode, not a real run.`);
    }
    console.log('');

    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare('SELECT id, content_identity_hash, avatar_identity_hash FROM characters WHERE content_identity_hash IS NOT NULL').all();
    db.close();
    console.log(`${rows.length} character rows carry a content_identity_hash to group.`);
    console.log('');

    const counters = await runDedupeSweep(rows, { apply: APPLY, limit: LIMIT });

    console.log('');
    console.log('--- summary ---');
    console.log(`rows with content_identity_hash:        ${rows.length}`);
    console.log(`duplicate-content groups found:         ${counters.groups}`);
    console.log(`candidate pairs (non-source members):   ${counters.pairs}`);
    console.log(`  missing file (skipped):               ${counters.missingFile}`);
    console.log(`  skipped, known avatar mismatch:       ${counters.skippedAvatarMismatch}`);
    if (APPLY) {
        console.log(`  reflinked:                            ${counters.reflinked}`);
        console.log(`  declined (verification failed):       ${counters.declined}`);
        console.log(`  errors:                                ${counters.errors}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually perform the reflink swap)');
    }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
