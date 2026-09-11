#!/usr/bin/env node
/**
 * One-off repair: for every group of character rows that share the SAME `avatar_identity_hash` (sha256
 * over each PNG's concatenated raw IDAT chunk payload bytes - see character-card-parser.js's
 * computeAvatarIdentityHashFromChunks() and character-metadata-db.js's SCHEMA_SQL comment on the column),
 * reclaims disk space for every member of the group beyond the first by reflinking it to share extents
 * with the group's canonical member - the SAME byte-level-verified mechanism reclaim-character-reflinks.mjs
 * already uses (reclaimReflinkPrefix(), character-card-parser.js), just matched against ANOTHER row already
 * inside this install's own characters/ directory instead of an external local-import source archive.
 *
 * This is for duplicate PNGs that never went through local-import's own staging reflink at all - e.g. two
 * cards that ended up with byte-identical image data through edit/fork history (a character duplicated in
 * the UI, or re-saved from the same source through two different paths) - so nothing else in this codebase
 * ever retroactively links them together.
 *
 * Matching: avatar_identity_hash equality is a CANDIDATE only. reclaimReflinkPrefix() independently
 * verifies the literal shared byte prefix between the two files before touching anything - a same-hash
 * pair whose files have since diverged in some way the hash doesn't cover is simply declined, never
 * guessed past.
 *
 * Within a duplicate group, the canonical (source) member is the lexicographically-smallest character id -
 * arbitrary but deterministic, so re-running this script against a group that already converged makes the
 * same choice again and finds nothing left to do.
 *
 * LIVE-SERVER SAFETY: read-only DB access (this script writes zero DB rows - avatar_identity_hash grouping
 * is the only thing it reads from the store). File-level work is per-pair, one reclaimReflinkPrefix() call
 * at a time, never a batch/bulk operation - same posture as reclaim-character-reflinks.mjs. A verification
 * failure for one pair only ever declines that pair and moves on to the next; it never touches a file it
 * hasn't independently byte-verified first.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/dedup-avatar-reflinks.mjs              (dry run - reports duplicate groups, touches nothing)
 *   node scripts/dedup-avatar-reflinks.mjs --apply       (performs the reflink reclaim for real)
 *   node scripts/dedup-avatar-reflinks.mjs --apply --limit 500   (cap how many pairs get reflinked -
 *       for a quick smoke test, not a real run)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { reclaimReflinkPrefix, computeDefaultAvatarIdentityHash } from '../src/character-card-parser.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');
const DB_PATH = path.join(REPO_ROOT, 'data', USER_HANDLE, 'character-metadata.sqlite');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const PAIR_LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        throw new Error(`No metadata store found at ${DB_PATH} - run this from the repo root, on an install that has already bootstrapped its character-metadata.sqlite.`);
    }

    console.log(`Mode: ${APPLY ? 'APPLY (files will be modified in place)' : 'DRY RUN (no files touched - pass --apply to perform the reclaim)'}`);
    if (Number.isFinite(PAIR_LIMIT)) {
        console.log(`Pair count capped at ${PAIR_LIMIT} (--limit) - smoke-test mode, not a real full run.`);
    }
    console.log('');

    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.prepare('SELECT id, avatar_identity_hash FROM characters WHERE avatar_identity_hash IS NOT NULL').all();
    db.close();
    console.log(`${rows.length} character rows carry an avatar_identity_hash.`);

    // The app's own placeholder avatar (assets/user-default.png or similar - see computeDefaultAvatarIdentityHash())
    // is shared by every character that never got a custom avatar. A "duplicate group" built from that hash is
    // hundreds/thousands of otherwise-unrelated characters, not the edit/fork-history duplicate case this script
    // is for - excluded here so it doesn't dominate the report or get treated as a real dedup target.
    const defaultHash = computeDefaultAvatarIdentityHash();

    /** @type {Map<string, string[]>} */
    const groups = new Map();
    for (const row of rows) {
        if (row.avatar_identity_hash === defaultHash) continue;
        const list = groups.get(row.avatar_identity_hash);
        if (list) list.push(row.id);
        else groups.set(row.avatar_identity_hash, [row.id]);
    }

    const dupeGroups = [...groups.values()].filter(ids => ids.length > 1);
    const totalDupeMembers = dupeGroups.reduce((sum, ids) => sum + ids.length, 0);
    const totalPairsToReclaim = dupeGroups.reduce((sum, ids) => sum + (ids.length - 1), 0);
    console.log(`${dupeGroups.length} duplicate group(s) found (same avatar_identity_hash), covering ${totalDupeMembers} rows total, ${totalPairsToReclaim} candidate pair(s) to reclaim.`);
    console.log('');

    let attempted = 0;
    let reflinked = 0;
    let declined = 0;
    let errors = 0;
    let missingFile = 0;

    outer:
    for (const ids of dupeGroups) {
        const sorted = [...ids].sort();
        const canonicalId = sorted[0];
        const canonicalPath = path.join(CHARACTERS_DIR, canonicalId);
        if (!fs.existsSync(canonicalPath)) {
            missingFile++;
            continue;
        }

        for (const memberId of sorted.slice(1)) {
            if (attempted >= PAIR_LIMIT) break outer;

            const existingPath = path.join(CHARACTERS_DIR, memberId);
            if (!fs.existsSync(existingPath)) {
                missingFile++;
                continue;
            }

            attempted++;
            if (!APPLY) continue;

            try {
                const result = await reclaimReflinkPrefix(existingPath, canonicalPath);
                if (result.reflinked) {
                    reflinked++;
                } else {
                    declined++;
                    console.log(`  declined: ${memberId} <- ${canonicalId} (${result.reason})`);
                }
            } catch (error) {
                errors++;
                console.warn(`  error: ${memberId} <- ${canonicalId} - ${/** @type {any} */ (error)?.message ?? error}`);
            }

            const processed = reflinked + declined + errors;
            if (processed > 0 && processed % 500 === 0) {
                console.log(`  ...${processed}/${totalPairsToReclaim} pairs processed so far (${reflinked} reflinked)`);
            }
        }
    }

    console.log('');
    console.log('--- summary ---');
    console.log(`duplicate groups:                    ${dupeGroups.length}`);
    console.log(`candidate pairs:                     ${totalPairsToReclaim}`);
    console.log(`  missing character file (skipped):  ${missingFile}`);
    console.log(`  attempted:                          ${attempted}`);
    if (APPLY) {
        console.log(`    reflinked:                        ${reflinked}`);
        console.log(`    declined (verification failed):   ${declined}`);
        console.log(`    errors:                            ${errors}`);
    } else {
        console.log('(dry run only - re-run with --apply to actually perform the reflink reclaim)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
