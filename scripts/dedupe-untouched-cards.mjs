#!/usr/bin/env node
/**
 * Retroactive one-time-ish sweep: reflinks EXISTING, untouched characters against each other whenever
 * they're semantically identical, closing a gap the live write path deliberately leaves open.
 *
 * findCrossCharacterReflinkCandidate() (src/endpoints/characters.js) already reflinks a character's file
 * against another character with a matching content_identity_hash - but only at the moment of a NEW write
 * to one of them. Two characters that already sit on disk, byte-for-byte independent copies of each other,
 * and that nobody happens to touch again, never get that chance - the live path only fires forward from a
 * write, it never looks backward over the whole existing corpus. This script is that backward look: a
 * one-time (but safely re-runnable - already-shared rows are simply re-verified and left alone) sweep over
 * every character row that already carries a content_identity_hash.
 *
 * content_identity_hash (characters table, character-metadata-db.js) is a semantic fingerprint of a card's
 * JSON with fav/chat/create_date stripped BEFORE hashing (stripInstallLocalFields(), computeContentIdentityHash()
 * in src/character-card-normalize.js) - so any two rows sharing the same content_identity_hash are, by
 * construction, identical except for that install-local fav/chat/create_date state. That makes the hash a
 * CANDIDATE grouping only; reclaimReflinkPrefix() (src/character-card-parser.js) independently verifies the
 * actual shared byte prefix - including the portrait, which content_identity_hash never covers - before
 * touching anything, so a wrong/stale grouping is simply declined, never guessed past.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/dedupe-untouched-cards.mjs                  (dry run - reports groups/candidates, touches nothing)
 *   node scripts/dedupe-untouched-cards.mjs --apply           (performs the reflink swap for real candidates)
 *   node scripts/dedupe-untouched-cards.mjs --apply --limit 500   (cap how many candidate pairs get processed -
 *       for a quick smoke test, not a real run)
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
 * @property {string} id Avatar filename, e.g. "Alice.png" - also the primary key of the characters table.
 * @property {string} content_identity_hash
 * @property {string | null} avatar_identity_hash
 */

/**
 * Groups character rows by content_identity_hash, keeping only groups with more than one member, then
 * within each group picks a single stable source (lowest id) and proposes every other member as a
 * candidate to reflink against it.
 * @param {CharacterRow[]} rows
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
 * Cheap prefilter only, not a safety requirement - reclaimReflinkPrefix() does its own real byte-level
 * verification and will decline safely regardless. This just skips a pair upfront when both rows already
 * carry a non-null avatar_identity_hash and they disagree: that means the portraits are KNOWN to differ,
 * so the byte-prefix check is certain to fail anyway - this saves the file reads for those doomed pairs.
 * @param {CharacterRow} source
 * @param {CharacterRow} candidate
 * @returns {boolean} true if the pair is a known-doomed mismatch and should be skipped without reading files
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
 * @param {string} [options.charactersDir] Directory character files live in.
 * @param {boolean} [options.apply] Perform the reflink swap for real; dry run (report only) when false.
 * @param {number} [options.limit] Cap on how many candidate pairs get processed - smoke-test mode.
 * @param {(existingPath: string, sourcePath: string) => Promise<{reflinked: boolean, reason?: string}>} [options.reclaim]
 * Injection point for reclaimReflinkPrefix(), overridable in tests.
 * @param {(p: string) => boolean} [options.exists] Injection point for fs.existsSync(), overridable in tests.
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
