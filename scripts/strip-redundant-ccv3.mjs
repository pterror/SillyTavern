#!/usr/bin/env node
/**
 * One-off cleanup: for every character PNG that carries both a 'chara' and a 'ccv3' tEXt chunk, strips
 * the 'ccv3' chunk only when it adds zero information beyond what 'chara' already holds.
 *
 * The bar is "adds no new info", not "nothing currently reads it" - a card whose ccv3 JSON carries real
 * v3-only field values not also present at the same path in 'chara' is left untouched.
 *
 * Comparison is field-level, not raw byte-equality: findExtraCcv3Info() walks the parsed ccv3 JSON
 * recursively, and any leaf not also present at the same path in 'chara' (and not itself empty/absent)
 * counts as extra info, skipping the whole card.
 *
 * Verification before touching anything:
 *   1. Re-extract the file's chunks fresh at apply time, not reused from the scan pass.
 *   2. Re-run findExtraCcv3Info() against that fresh extraction.
 *   3. Build the new chunk list (every chunk unchanged except 'ccv3' removed).
 *   4. Write via write-file-atomic.
 *   5. Byte-verify off disk: no 'ccv3' chunk, 'chara' bytes unchanged, and
 *      computeAvatarIdentityHashFromChunks() matches the pre-write hash.
 *
 * Resumable for free: an already-stripped file no longer carries a 'ccv3' chunk, so a re-run's scan
 * pass naturally skips it.
 *
 * Usage (run from the repo root, inside the project's dev shell so dependencies resolve):
 *   node scripts/strip-redundant-ccv3.mjs                       (dry run - reports candidates, touches nothing)
 *   node scripts/strip-redundant-ccv3.mjs --apply --limit 20    (applies to at most 20 real candidates - the
 *       small verified-sample pass; ALWAYS run this before an unlimited --apply)
 *   node scripts/strip-redundant-ccv3.mjs --apply                (full run over every candidate - only after
 *       the sample pass above has been reviewed and explicitly approved)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import encode from '../src/png/encode.js';
import { computeAvatarIdentityHashFromChunks } from '../src/character-card-parser.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const USER_HANDLE = 'default-user';
const CHARACTERS_DIR = path.join(REPO_ROOT, 'data', USER_HANDLE, 'characters');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArgIndex = args.indexOf('--limit');
const LIMIT = limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) : Infinity;

function isEmptyValue(v) {
    return v === undefined || v === null || v === ''
        || (Array.isArray(v) && v.length === 0)
        || (typeof v === 'object' && v !== null && Object.keys(v).length === 0);
}

/** Sorted-key JSON.stringify, so deep-equal doesn't false-positive on key order alone. */
function canonical(v) {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') {
        return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonical(v[k]); return acc; }, {});
    }
    return v;
}

function deepEqual(a, b) {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

// 'spec'/'spec_version' always differ between a v3 'chara' downgrade and 'ccv3' (2.0 vs 3.0) - that's
// just the wrapper's version label, not character content, so it isn't "extra info".
const IGNORED_ROOT_KEYS = new Set(['spec', 'spec_version']);

/** Walks `ccv3Node`, collecting every leaf (arrays compared as one leaf, not diffed element-wise) not
 * present at the same path in `charaNode`. */

function findExtraCcv3Info(ccv3Node, charaNode, pathPrefix = '') {
    if (ccv3Node !== null && typeof ccv3Node === 'object' && !Array.isArray(ccv3Node)) {
        const charaObj = (charaNode !== null && typeof charaNode === 'object' && !Array.isArray(charaNode)) ? charaNode : {};
        const extras = [];
        for (const key of Object.keys(ccv3Node)) {
            if (pathPrefix === '' && IGNORED_ROOT_KEYS.has(key)) continue;
            extras.push(...findExtraCcv3Info(ccv3Node[key], charaObj[key], pathPrefix ? `${pathPrefix}.${key}` : key));
        }
        return extras;
    }

    if (isEmptyValue(ccv3Node) || deepEqual(ccv3Node, charaNode)) {
        return [];
    }

    return [{ path: pathPrefix, ccv3Value: ccv3Node, charaValue: charaNode }];
}

function findTextChunk(chunks, keyword) {
    for (const chunk of chunks) {
        if (chunk.name !== 'tEXt') continue;
        const decoded = PNGtext.decode(chunk.data);
        if (decoded.keyword.toLowerCase() === keyword) return { chunk, decoded };
    }
    return null;
}

function scanCandidate(filePath) {
    const buf = fs.readFileSync(filePath);
    const chunks = extract(new Uint8Array(buf));

    const charaEntry = findTextChunk(chunks, 'chara');
    const ccv3Entry = findTextChunk(chunks, 'ccv3');

    if (!ccv3Entry) return { status: 'no-ccv3' };
    if (!charaEntry) return { status: 'ccv3-only-no-chara' };

    let charaJson, ccv3Json;
    try {
        charaJson = JSON.parse(Buffer.from(charaEntry.decoded.text, 'base64').toString('utf8'));
        ccv3Json = JSON.parse(Buffer.from(ccv3Entry.decoded.text, 'base64').toString('utf8'));
    } catch (error) {
        return { status: 'unparseable', error: /** @type {any} */ (error)?.message ?? String(error) };
    }

    const extras = findExtraCcv3Info(ccv3Json, charaJson);
    if (extras.length > 0) {
        return { status: 'has-extra-info', extras };
    }

    return { status: 'safe-to-strip', chunks, charaEntry, ccv3Entry };
}

function stripCandidate(filePath) {
    const verdict = scanCandidate(filePath);
    if (verdict.status !== 'safe-to-strip') {
        return { applied: false, reason: `re-scan at apply time came back '${verdict.status}', not 'safe-to-strip' - declined` };
    }

    const { chunks, charaEntry, ccv3Entry } = verdict;
    const preImageHash = computeAvatarIdentityHashFromChunks(chunks);
    const charaBytesBefore = Buffer.from(charaEntry.chunk.data);

    const newChunks = chunks.filter((c) => c !== ccv3Entry.chunk);
    const outputBuf = Buffer.from(encode(newChunks));

    writeFileAtomicSync(filePath, outputBuf);

    const verifyBuf = fs.readFileSync(filePath);
    const verifyChunks = extract(new Uint8Array(verifyBuf));
    const verifyCcv3 = findTextChunk(verifyChunks, 'ccv3');
    const verifyChara = findTextChunk(verifyChunks, 'chara');
    const postImageHash = computeAvatarIdentityHashFromChunks(verifyChunks);

    if (verifyCcv3) {
        return { applied: false, reason: 'post-write verification FAILED: ccv3 chunk still present' };
    }
    if (!verifyChara || Buffer.compare(Buffer.from(verifyChara.chunk.data), charaBytesBefore) !== 0) {
        return { applied: false, reason: 'post-write verification FAILED: chara chunk missing or changed' };
    }
    if (postImageHash !== preImageHash) {
        return { applied: false, reason: 'post-write verification FAILED: avatar image hash changed' };
    }

    return { applied: true };
}

function main() {
    console.log(`Mode: ${APPLY ? 'APPLY (files will be modified in place)' : 'DRY RUN (no files touched - pass --apply to strip for real)'}`);
    if (Number.isFinite(LIMIT)) {
        console.log(`Limited to ${LIMIT} candidate${LIMIT === 1 ? '' : 's'} actually stripped this run (--limit) - sample/smoke-test mode.`);
    }
    console.log(`Characters directory: ${CHARACTERS_DIR}`);
    console.log('');

    if (!fs.existsSync(CHARACTERS_DIR)) {
        throw new Error(`Characters directory not found at ${CHARACTERS_DIR}.`);
    }

    const entries = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.png'));

    console.log(`${entries.length} character files found.`);
    console.log('');

    let scanned = 0;
    let noCcv3 = 0;
    let unparseable = 0;
    let hasExtraInfo = 0;
    let safeToStrip = 0;
    let stripped = 0;
    let declinedAtApply = 0;
    let errors = 0;
    const startedAt = Date.now();

    const sampleExtras = [];

    for (const entry of entries) {
        const filePath = path.join(CHARACTERS_DIR, entry.name);
        scanned++;

        let verdict;
        try {
            verdict = scanCandidate(filePath);
        } catch (error) {
            errors++;
            console.warn(`  error scanning ${entry.name}: ${/** @type {any} */ (error)?.message ?? error}`);
            continue;
        }

        if (verdict.status === 'no-ccv3') { noCcv3++; continue; }
        if (verdict.status === 'unparseable') { unparseable++; console.warn(`  unparseable chara/ccv3 JSON, skipped: ${entry.name} - ${verdict.error}`); continue; }
        if (verdict.status === 'ccv3-only-no-chara') { console.warn(`  ccv3 present with no chara chunk (foreign layout), skipped: ${entry.name}`); continue; }
        if (verdict.status === 'has-extra-info') {
            hasExtraInfo++;
            if (sampleExtras.length < 10) {
                sampleExtras.push({ name: entry.name, paths: verdict.extras.map((e) => e.path) });
            }
            continue;
        }

        // safe-to-strip
        safeToStrip++;
        if (!APPLY) continue;
        if (stripped >= LIMIT) continue;

        try {
            const result = stripCandidate(filePath);
            if (result.applied) {
                stripped++;
                console.log(`  stripped: ${entry.name}`);
            } else {
                declinedAtApply++;
                console.warn(`  declined at apply: ${entry.name} - ${result.reason}`);
            }
        } catch (error) {
            errors++;
            console.warn(`  error stripping ${entry.name}: ${/** @type {any} */ (error)?.message ?? error}`);
        }

        if (stripped > 0 && stripped % 1000 === 0) {
            const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
            console.log(`  ...${stripped} stripped so far (${scanned}/${entries.length} scanned, ${elapsedSec}s elapsed)`);
        }

        // A dry run always scans everything so its summary counts stay complete; APPLY mode only needs
        // `LIMIT` real candidates, so stop scanning once satisfied rather than reading the whole library.
        if (APPLY && Number.isFinite(LIMIT) && stripped >= LIMIT) {
            break;
        }

        if (scanned % 500 === 0 || scanned === entries.length) {
            const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
            console.log(`  ...${scanned}/${entries.length} scanned (${elapsedSec}s elapsed)`);
        }
    }

    console.log('');
    console.log('--- summary ---');
    console.log(`character files scanned:            ${scanned}`);
    console.log(`  no ccv3 chunk (nothing to do):     ${noCcv3}`);
    console.log(`  unparseable chara/ccv3 JSON:       ${unparseable}`);
    console.log(`  ccv3 has genuine extra info:       ${hasExtraInfo}`);
    console.log(`  safe to strip (ccv3 adds nothing): ${safeToStrip}`);
    console.log(`  scan errors:                       ${errors}`);
    if (APPLY) {
        console.log(`    stripped:                         ${stripped}`);
        console.log(`    declined at apply-time re-scan:   ${declinedAtApply}`);
    } else {
        console.log('(dry run only - re-run with --apply [--limit N] to strip for real)');
    }

    if (sampleExtras.length > 0) {
        console.log('');
        console.log(`sample of cards with genuine extra ccv3 info (left untouched), up to 10 shown:`);
        for (const s of sampleExtras) {
            console.log(`  ${s.name}: extra field paths -> ${s.paths.join(', ')}`);
        }
    }
}

main();
