#!/usr/bin/env node
/* eslint-env node */
/**
 * The library search as the app runs it (`LibraryEngine.query({ search })`, build path 5d) on a synthetic library:
 * each query's median time over 7 runs after one warm-up, in relevance order and by name, with its total; then
 * edits through `writeCard()`, each looked for by the next search.
 *
 * The library is the engine's search bench's (`engine/examples/search.rs` with `--real`: `scripts/`' old text
 * generator, 30,000-word Zipf vocabulary, the bench's words at the live library's shares, fixed numbers for its
 * samples), written there and opened here. Nothing outside the store directory is read or written.
 *
 * Usage:
 *   cargo run --release --features measure --example search -- <store dir> synth <cards> --real --bulk --no-check
 *   node scripts/bench-search-synth.mjs --store <store dir> [--edits 50] [--pairs]
 * `--pairs` turns pair postings on first and times their build. Prints one JSON object per query, one for the
 * edits, and one for the build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The engine bench's query set, as typed. */
export const QUERIES = [
    'girl', 'the', 'love', 'dragon', 'vampire', 'detective', 'saxophone', 'quokka', 'dr', 'dra',
    'dark knight', 'the girl', 'vampire love', 'the dark knight', 'girl love dragon',
    '"dark knight"', '"the dragon"', 'tag:dragon', 'name:dr', 'girl -tag:vampire',
];

/**
 * @param {() => Promise<unknown>} run
 * @returns {Promise<number>} The median of 7 runs, in ms, after one warm-up.
 */
async function median(run) {
    await run();
    const times = [];
    for (let i = 0; i < 7; i++) {
        const t = performance.now();
        await run();
        times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return times[3];
}

async function main() {
    const { values } = parseArgs({ options: { store: { type: 'string' }, edits: { type: 'string', default: '50' }, pairs: { type: 'boolean', default: false } } });
    if (!values.store) throw new Error('--store <dir>: a store the engine bench wrote with --real');
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(REPO_ROOT, 'default', 'config.yaml'));
    const { LibraryEngine } = await import('../src/library-engine.js');
    const { loadEngine } = await import('../engine/load.js');
    const lib = await LibraryEngine.open(loadEngine().binding, path.resolve(values.store));
    const runBytes = () => fs.readdirSync(path.join(values.store, 'runs')).reduce((n, f) => n + fs.statSync(path.join(values.store, 'runs', f)).size, 0);
    try {
        if (values.pairs) {
            const before = runBytes();
            const t = performance.now();
            await lib.setPairPostings(true);
            await lib.runPairPostings(0);
            console.log(JSON.stringify({ phase: 'pairs', build_s: Number(((performance.now() - t) / 1000).toFixed(1)), runs_before: before, runs_after: runBytes() }));
        }
        for (const search of QUERIES) {
            for (const sortField of ['search', 'name']) {
                const query = () => lib.query({ search, sortField, limit: 50, includeGroups: true });
                const ms = await median(query);
                const out = /** @type {any} */ (await query());
                console.log(JSON.stringify({ phase: 'query', q: search, order: sortField, median_ms: Number(ms.toFixed(3)), rows: out.rows.length, total: out.total, approx: out.approxTotal, chips: out.tagMatches?.length ?? 0 }));
            }
        }
        // Edits through the app's write path, each looked for by the next search.
        const page = /** @type {any} */ (await lib.query({ sortField: 'name', limit: Number(values.edits) }));
        let found = 0;
        const write = [];
        const read = [];
        for (const [i, row] of page.rows.entries()) {
            const [card] = /** @type {any[]} */ (await lib.cards([row.id]));
            const word = `freshjs${i}word`;
            card.data = { ...card.data, description: `${card.data?.description ?? ''} ${word}` };
            let t = performance.now();
            await lib.writeCard({}, row.id, JSON.stringify(card), { dateAdded: row.date_added });
            write.push(performance.now() - t);
            t = performance.now();
            const hit = /** @type {any} */ (await lib.query({ search: word, sortField: 'search', limit: 5 }));
            read.push(performance.now() - t);
            if (hit.rows.some((/** @type {any} */ r) => r.id === row.id)) found++;
        }
        const p50 = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
        console.log(JSON.stringify({ phase: 'freshness', edits: page.rows.length, found_by_next_query: found, write_ms_p50: Number(p50(write).toFixed(3)), query_ms_p50: Number(p50(read).toFixed(3)) }));
    } finally {
        await lib.close();
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
