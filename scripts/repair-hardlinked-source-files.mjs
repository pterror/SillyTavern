#!/usr/bin/env node
/**
 * One-off repair: gives back an independent inode to every source-archive file whose directory entry was
 * destructively replaced with a hardlink to an already-imported character's canonical file, by the now-removed
 * `hardlinkOntoCanonical()` (see local-import-copy.js's trailing comment for the full story of why that function
 * was backwards and got removed in favor of reclaimReflinkPrefix(), which only ever reflinks the CANONICAL file).
 *
 * Where this differs from reclaim-character-reflinks.mjs: that script fixes the CANONICAL file (giving it back
 * reflink-shared extents with a source it was fully, independently copied from). This script fixes the SOURCE
 * file instead - the direction the removed function got wrong - by giving it back its own independent inode,
 * still sharing disk extents with the canonical file via reflink (never a hardlink, and the canonical file is
 * only ever read from, never opened for writing).
 *
 * Candidate discovery is by INODE NUMBER, not content hash: every `--links 2` file under the source archive dir
 * is looked up by inode against every `--links +1` file in the canonical characters dir. A match is only a
 * candidate - each pair is independently re-verified live (fresh stat + sha256, right before the reflink) before
 * anything is touched, exactly the same "match is never trusted on its own" shape as reclaimReflinkPrefix().
 *
 * Repair, per pair:
 *   1. Fresh stat of both paths - confirms they still share the SAME inode with nlink === 2 (guards against any
 *      change since the candidate list was built, and against ever acting on a stale/incorrect pairing).
 *   2. sha256 of both paths - since they currently share one inode this is expected to trivially match; a
 *      mismatch here means the on-disk state moved between listing and repair, and the pair is declined, never
 *      guessed past.
 *   3. Reflink-clone the canonical file's current bytes into a fresh same-directory temp file next to the
 *      source path (`@reflink/reflink`'s reflinkFile(), same primitive local-import-copy.js's copyCharacterFile()
 *      and character-card-parser.js's writeSharedPrefixThenAppend() already use elsewhere in this codebase).
 *   4. Verify the temp file's bytes match the canonical file's bytes, and that it already has a fresh inode
 *      distinct from both the canonical file's and the (still-hardlinked) source path's.
 *   5. chmod/chown the temp file to match the ORIGINAL source path's mode/uid/gid (reflinkFile clones the
 *      canonical file's content, not the source's ownership - the archive file's own metadata should survive
 *      this repair, not silently become a copy of the canonical file's).
 *   6. If a `--mirror-db` was given, set the temp file's mtime/atime to that source file's original
 *      `mirror_state.downloaded_at` (matched by basename) BEFORE the rename, so the timestamp that lands on
 *      disk is correct from the very first moment the repaired file exists - never a separate write-then-touch
 *      step with a window where the file briefly carries the wrong time. Whatever mtime the file had going
 *      into this repair was already wrong (see below), so there's nothing worth preserving there; a
 *      `downloaded_at` match is strictly better provenance than either "repair time" or "inherited-from-hardlink
 *      time".
 *   7. Atomically rename the temp file over the source path - the same write-to-temp-then-atomic-rename shape
 *      used everywhere else in this codebase, so there is never a moment where the source path doesn't exist or
 *      holds partial content.
 *   8. Post-verify: source path now has nlink === 1 and a fresh inode, its bytes still match, and the canonical
 *      file's inode/nlink/size/mtime are all unchanged (it was never opened for writing).
 *
 * On mtime: a file's directory entry losing its own inode to a hardlink (step 0, the original bug) means its
 * mtime was ALREADY overwritten with the canonical file's mtime the moment the bug ran - there is no genuine
 * "original" mtime left sitting on disk to preserve going into this repair either way. `/mnt/ssd/chub/mirror.sqlite`
 * (`mirror_state.filename` -> `downloaded_at`) turned out to cover ~99.6% of this specific archive by basename and
 * is real archival provenance (the actual original download time), so `--mirror-db` uses it when given. The
 * remaining ~0.4% with no match, and any run without `--mirror-db` at all, get whatever mtime `rename()` naturally
 * produces (repair time) - reported separately in the summary, never silently conflated with a restored match.
 *
 * Naturally resumable: an already-repaired source file has nlink === 1, so it's simply absent from the next
 * run's `--links 2` candidate list - no separate bookkeeping needed.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/repair-hardlinked-source-files.mjs --source-dir /path/to/archive     (dry run - reports
 *       candidates and verification results, touches nothing)
 *   node scripts/repair-hardlinked-source-files.mjs --source-dir /path/to/archive --apply
 *   node scripts/repair-hardlinked-source-files.mjs --source-dir /path/to/archive --apply --mirror-db /path/to/mirror.sqlite
 *       (also restores original download mtime/atime for files with a matching mirror_state row)
 *   node scripts/repair-hardlinked-source-files.mjs --source-dir /path/to/archive --apply --limit 20   (smoke
 *       test on the first 20 candidates only)
 *   node scripts/repair-hardlinked-source-files.mjs --source-dir /path/to/archive --apply --only <substring>
 *       (restrict to candidates whose source path contains the given substring - single-file testing)
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { loadReflinkModule } from '../src/reflink-support.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CANONICAL_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const sourceDirIndex = args.indexOf('--source-dir');
if (sourceDirIndex === -1 || !args[sourceDirIndex + 1]) {
    console.error('Usage: node scripts/repair-hardlinked-source-files.mjs --source-dir <path> [--apply] [--mirror-db <path>] [--limit N] [--only <substring>]');
    process.exit(1);
}
const SOURCE_DIR = path.resolve(args[sourceDirIndex + 1]);

const limitArgIndex = args.indexOf('--limit');
const LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

const onlyArgIndex = args.indexOf('--only');
const ONLY_SUBSTRING = onlyArgIndex !== -1 ? args[onlyArgIndex + 1] : null;

const mirrorDbIndex = args.indexOf('--mirror-db');
const MIRROR_DB_PATH = mirrorDbIndex !== -1 ? path.resolve(args[mirrorDbIndex + 1]) : null;

/**
 * Loads `mirror_state.filename -> downloaded_at` (only rows with status 'downloaded' and a non-null
 * downloaded_at) as a single bulk query - a per-file prepared-statement lookup over 300k+ rows measured far
 * slower than this, and this only ever needs to run once regardless of how many candidate pairs exist.
 * @returns {Map<string, Date>}
 */
function loadMirrorMtimeIndex() {
    const db = new Database(MIRROR_DB_PATH, { readonly: true });
    try {
        const rows = db.prepare("SELECT filename, downloaded_at FROM mirror_state WHERE status = 'downloaded' AND downloaded_at IS NOT NULL").all();
        /** @type {Map<string, Date>} */
        const index = new Map();
        for (const row of rows) {
            if (index.has(row.filename)) continue; // first wins, same reasoning as the source-hash index in reclaim-character-reflinks.mjs
            const parsed = new Date(row.downloaded_at);
            if (!Number.isNaN(parsed.getTime())) index.set(row.filename, parsed);
        }
        return index;
    } finally {
        db.close();
    }
}

/**
 * @param {string} filePath
 * @returns {Promise<string>} sha256 hex digest, streamed so this scales past small files.
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
 * Shells out to `find` for the inode+path listing - the same tool/flags used to manually establish ground
 * truth about this corpus before writing this script, and far faster here than an equivalent readdir+stat
 * walk in Node over hundreds of thousands of entries.
 * @param {string} dir
 * @param {string[]} extraFindArgs
 * @returns {Promise<Array<{ino: string, filePath: string}>>}
 */
async function findWithInode(dir, extraFindArgs) {
    const { stdout } = await execFileAsync('find', [dir, ...extraFindArgs, '-printf', '%i\t%p\n'], {
        maxBuffer: 1024 * 1024 * 1024,
    });
    const lines = stdout.split('\n').filter(Boolean);
    return lines.map((line) => {
        const tabIdx = line.indexOf('\t');
        return { ino: line.slice(0, tabIdx), filePath: line.slice(tabIdx + 1) };
    });
}

/**
 * @returns {Promise<Array<{sourcePath: string, canonicalPath: string}>>}
 */
async function findCandidatePairs() {
    console.log(`Scanning source dir for nlink=2 files: ${SOURCE_DIR}`);
    const sourceEntries = await findWithInode(SOURCE_DIR, ['-type', 'f', '-links', '2']);
    console.log(`  ${sourceEntries.length} nlink=2 files found in source dir.`);

    console.log(`Scanning canonical dir for nlink>1 files: ${CANONICAL_DIR}`);
    const canonicalEntries = await findWithInode(CANONICAL_DIR, ['-maxdepth', '1', '-type', 'f', '-links', '+1']);
    console.log(`  ${canonicalEntries.length} nlink>1 files found in canonical dir.`);

    /** @type {Map<string, string>} */
    const canonicalByIno = new Map();
    const duplicateInoInCanonical = new Set();
    for (const entry of canonicalEntries) {
        if (canonicalByIno.has(entry.ino)) {
            duplicateInoInCanonical.add(entry.ino);
            continue;
        }
        canonicalByIno.set(entry.ino, entry.filePath);
    }
    if (duplicateInoInCanonical.size > 0) {
        console.warn(`  WARNING: ${duplicateInoInCanonical.size} inode(s) appear more than once in the canonical dir listing - excluding those from candidates (unexpected shape, needs its own look before touching).`);
    }

    const pairs = [];
    let noCanonicalMatch = 0;
    for (const entry of sourceEntries) {
        if (duplicateInoInCanonical.has(entry.ino)) continue;
        const canonicalPath = canonicalByIno.get(entry.ino);
        if (!canonicalPath) {
            noCanonicalMatch++;
            continue;
        }
        pairs.push({ sourcePath: entry.filePath, canonicalPath });
    }

    console.log(`  ${pairs.length} source files matched by inode to a canonical file (genuine source<->dest pairs).`);
    if (noCanonicalMatch > 0) {
        console.log(`  ${noCanonicalMatch} nlink=2 source files had NO canonical-dir match by inode - left entirely untouched (could be a source<->source pair, or linked to something outside the canonical dir; needs separate investigation, not this script).`);
    }

    return pairs;
}

/**
 * Repairs a single verified pair: reflinks the canonical file's current bytes onto a fresh independent inode
 * at `sourcePath`, preserving `sourcePath`'s own mode/uid/gid, via write-to-temp-then-atomic-rename.
 * @param {string} sourcePath
 * @param {string} canonicalPath
 * @param {import('node:fs').Stats} sourceStatBefore
 * @param {Map<string, Date> | null} mirrorMtimeIndex Optional filename -> original-download-time index (see
 * loadMirrorMtimeIndex()). When a match exists for `sourcePath`'s basename, the temp file's mtime/atime is set
 * to it BEFORE the rename, so the restored timestamp is in place from the moment the repaired file exists.
 * @returns {Promise<{repaired: boolean, reason?: string, mtimeRestored: boolean}>}
 */
async function repairPair(sourcePath, canonicalPath, sourceStatBefore, mirrorMtimeIndex) {
    const reflinkModule = await loadReflinkModule();
    if (!reflinkModule) {
        return { repaired: false, reason: 'reflink-module-unavailable', mtimeRestored: false };
    }

    const tempPath = `${sourcePath}.${crypto.randomUUID()}.reflink-repair.tmp`;
    let mtimeRestored = false;
    try {
        await reflinkModule.reflinkFile(canonicalPath, tempPath);

        const [tempStat, canonicalHash, tempHash] = await Promise.all([
            fsPromises.stat(tempPath),
            sha256File(canonicalPath),
            sha256File(tempPath),
        ]);

        if (tempHash !== canonicalHash) {
            throw new Error(`temp file content does not match canonical file after reflink (${tempHash} vs ${canonicalHash})`);
        }
        if (tempStat.ino === sourceStatBefore.ino) {
            throw new Error('temp file unexpectedly shares an inode with the still-hardlinked source path');
        }

        await fsPromises.chmod(tempPath, sourceStatBefore.mode);
        if (process.getuid) {
            await fsPromises.chown(tempPath, sourceStatBefore.uid, sourceStatBefore.gid).catch(() => {});
        }

        const originalMtime = mirrorMtimeIndex?.get(path.basename(sourcePath));
        if (originalMtime) {
            await fsPromises.utimes(tempPath, originalMtime, originalMtime);
            mtimeRestored = true;
        }

        await fsPromises.rename(tempPath, sourcePath);
        return { repaired: true, mtimeRestored };
    } catch (error) {
        await fsPromises.unlink(tempPath).catch(() => {});
        return { repaired: false, reason: /** @type {any} */ (error)?.message ?? String(error), mtimeRestored: false };
    }
}

async function main() {
    if (!fs.existsSync(SOURCE_DIR)) {
        throw new Error(`Source dir not found: ${SOURCE_DIR}`);
    }
    if (!fs.existsSync(CANONICAL_DIR)) {
        throw new Error(`Canonical characters dir not found: ${CANONICAL_DIR}`);
    }

    console.log(`Mode: ${APPLY ? 'APPLY (files will be modified in place)' : 'DRY RUN (no files touched - pass --apply to perform the repair)'}`);
    console.log(`Source archive dir: ${SOURCE_DIR}`);
    console.log(`Canonical characters dir: ${CANONICAL_DIR}`);
    if (Number.isFinite(LIMIT)) console.log(`Limited to the first ${LIMIT} candidates (--limit) - smoke-test mode, not a real full run.`);
    if (ONLY_SUBSTRING) console.log(`Restricted to candidates whose source path contains: ${ONLY_SUBSTRING}`);

    /** @type {Map<string, Date> | null} */
    let mirrorMtimeIndex = null;
    if (MIRROR_DB_PATH) {
        if (!fs.existsSync(MIRROR_DB_PATH)) {
            throw new Error(`--mirror-db path not found: ${MIRROR_DB_PATH}`);
        }
        mirrorMtimeIndex = loadMirrorMtimeIndex();
        console.log(`Mirror mtime index loaded from ${MIRROR_DB_PATH}: ${mirrorMtimeIndex.size} filename -> downloaded_at entries.`);
    } else {
        console.log('No --mirror-db given - repaired files will carry repair-time as their mtime, not restored original download time.');
    }
    console.log('');

    let pairs = await findCandidatePairs();
    if (ONLY_SUBSTRING) pairs = pairs.filter((p) => p.sourcePath.includes(ONLY_SUBSTRING));
    if (Number.isFinite(LIMIT)) pairs = pairs.slice(0, LIMIT);

    console.log('');
    console.log(`Processing ${pairs.length} candidate pair(s)...`);
    console.log('');

    let verifiedOk = 0;
    let repaired = 0;
    let mtimeRestoredCount = 0;
    let mtimeNoMatchCount = 0;
    let declinedStaleState = 0;
    let declinedHashMismatch = 0;
    let declinedRepairFailed = 0;
    let canonicalMutatedGuard = 0;
    let errors = 0;
    const startedAt = Date.now();

    for (let i = 0; i < pairs.length; i++) {
        const { sourcePath, canonicalPath } = pairs[i];
        try {
            const [sourceStat, canonicalStatBefore] = await Promise.all([
                fsPromises.lstat(sourcePath),
                fsPromises.lstat(canonicalPath),
            ]);

            if (sourceStat.ino !== canonicalStatBefore.ino || sourceStat.nlink !== 2 || canonicalStatBefore.nlink !== 2) {
                declinedStaleState++;
                console.log(`  declined (stale state, no longer a clean source<->dest pair): ${sourcePath}`);
                continue;
            }

            const [sourceHash, canonicalHash] = await Promise.all([
                sha256File(sourcePath),
                sha256File(canonicalPath),
            ]);
            if (sourceHash !== canonicalHash) {
                declinedHashMismatch++;
                console.log(`  declined (content mismatch despite shared inode - investigate before re-running): ${sourcePath}`);
                continue;
            }

            verifiedOk++;
            if (!APPLY) continue;

            const result = await repairPair(sourcePath, canonicalPath, sourceStat, mirrorMtimeIndex);
            if (!result.repaired) {
                declinedRepairFailed++;
                console.log(`  repair failed: ${sourcePath} (${result.reason})`);
                continue;
            }
            if (mirrorMtimeIndex) {
                if (result.mtimeRestored) mtimeRestoredCount++;
                else mtimeNoMatchCount++;
            }

            const [sourceStatAfter, canonicalStatAfter, sourceHashAfter] = await Promise.all([
                fsPromises.lstat(sourcePath),
                fsPromises.lstat(canonicalPath),
                sha256File(sourcePath),
            ]);

            if (canonicalStatAfter.ino !== canonicalStatBefore.ino
                || canonicalStatAfter.mtimeMs !== canonicalStatBefore.mtimeMs
                || canonicalStatAfter.size !== canonicalStatBefore.size) {
                canonicalMutatedGuard++;
                console.error(`  POST-REPAIR ALARM: canonical file appears changed after repairing ${sourcePath} - canonical=${canonicalPath}. STOP and investigate.`);
                break;
            }
            if (sourceStatAfter.nlink !== 1 || sourceStatAfter.ino === canonicalStatAfter.ino || sourceHashAfter !== sourceHash) {
                errors++;
                console.error(`  POST-REPAIR VERIFICATION FAILED for ${sourcePath}: nlink=${sourceStatAfter.nlink}, ino-shared=${sourceStatAfter.ino === canonicalStatAfter.ino}, hash-match=${sourceHashAfter === sourceHash}`);
                continue;
            }

            repaired++;
        } catch (error) {
            errors++;
            console.warn(`  error: ${sourcePath} - ${/** @type {any} */ (error)?.message ?? error}`);
        }

        const processed = i + 1;
        if (processed % 500 === 0 || processed === pairs.length) {
            const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
            console.log(`  ...${processed}/${pairs.length} processed (${elapsedSec}s elapsed)`);
        }
    }

    console.log('');
    console.log('--- summary ---');
    console.log(`candidate pairs:                    ${pairs.length}`);
    console.log(`  declined (stale state):           ${declinedStaleState}`);
    console.log(`  declined (hash mismatch):         ${declinedHashMismatch}`);
    console.log(`  verified ok (safe to repair):     ${verifiedOk}`);
    if (APPLY) {
        console.log(`    repaired:                        ${repaired}`);
        console.log(`    declined (repair itself failed):${declinedRepairFailed}`);
        console.log(`    canonical-mutation guard tripped:${canonicalMutatedGuard}`);
        console.log(`    post-repair verification errors:${errors}`);
        if (mirrorMtimeIndex) {
            console.log(`    mtime restored from mirror db:  ${mtimeRestoredCount}`);
            console.log(`    mtime NOT matched (repair-time):${mtimeNoMatchCount}`);
        }
    } else {
        console.log('(dry run only - re-run with --apply to actually perform the repair)');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
