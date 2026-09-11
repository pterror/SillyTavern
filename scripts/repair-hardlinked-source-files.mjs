#!/usr/bin/env node
/**
 * One-off repair: gives back an independent inode to every source-archive file whose directory entry was
 * destructively replaced with a hardlink to an already-imported character's canonical file, by the now-removed
 * `hardlinkOntoCanonical()`.
 *
 * Where this differs from reclaim-character-reflinks.mjs: that script fixes the canonical file. This script
 * fixes the source file - giving it back its own independent inode, still sharing disk extents with the
 * canonical file via reflink (never a hardlink; the canonical file is only ever read, never written).
 *
 * Candidate discovery is by inode number, not content hash: every `--links 2` file under the source archive dir
 * is looked up by inode against every `--links +1` file in the canonical characters dir. A match is only a
 * candidate - each pair is independently re-verified live (fresh stat + sha256, right before the reflink).
 *
 * Repair, per pair:
 *   1. Fresh stat of both paths - confirms they still share the same inode with nlink === 2.
 *   2. sha256 of both paths - a mismatch means on-disk state moved since listing, and the pair is declined.
 *   3. Reflink-clone the canonical file's current bytes into a fresh same-directory temp file.
 *   4. Verify the temp file's bytes match and it has a fresh inode distinct from both source and canonical.
 *   5. chmod/chown the temp file to the ORIGINAL source path's mode/uid/gid (reflinkFile only clones content).
 *   6. If `--mirror-db` was given, set the temp file's mtime/atime to `mirror_state.downloaded_at` (matched by
 *      basename) BEFORE the rename, so the correct timestamp is in place from the moment the file exists.
 *   7. Atomically rename the temp file over the source path.
 *   8. Post-verify: source path now has nlink === 1 and a fresh inode, bytes still match, and the canonical
 *      file's inode/nlink/size/mtime are unchanged.
 *
 * On mtime: the original bug already overwrote the source's mtime with the canonical file's the moment it ran,
 * so there's no genuine original mtime to preserve. `--mirror-db` restores `downloaded_at` provenance when a
 * basename match exists (~99.6% of the archive this was built against); the rest get repair-time, reported
 * separately in the summary.
 *
 * Naturally resumable: an already-repaired source file has nlink === 1, so it's absent from the next run's
 * `--links 2` candidate list.
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

/** Single bulk query - a per-file prepared-statement lookup over 300k+ rows measured far slower. */
function loadMirrorMtimeIndex() {
    const db = new Database(MIRROR_DB_PATH, { readonly: true });
    try {
        const rows = db.prepare("SELECT filename, downloaded_at FROM mirror_state WHERE status = 'downloaded' AND downloaded_at IS NOT NULL").all();
        const index = new Map();
        for (const row of rows) {
            if (index.has(row.filename)) continue;
            const parsed = new Date(row.downloaded_at);
            if (!Number.isNaN(parsed.getTime())) index.set(row.filename, parsed);
        }
        return index;
    } finally {
        db.close();
    }
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/** Shells out to `find` - far faster than an equivalent readdir+stat walk over hundreds of thousands of entries. */
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
        console.warn(`  WARNING: ${duplicateInoInCanonical.size} inode(s) appear more than once in the canonical dir listing - excluding those from candidates.`);
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

/** Reflinks the canonical file's current bytes onto a fresh independent inode at `sourcePath`, preserving
 * `sourcePath`'s own mode/uid/gid, via write-to-temp-then-atomic-rename. */
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
