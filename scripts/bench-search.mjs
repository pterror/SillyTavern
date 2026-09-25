#!/usr/bin/env node
/* eslint-env node */
/**
 * Search benchmark: times `POST /api/characters/query` end to end in the main list's real request shape,
 * against a consistent snapshot of the user's metadata DB (SQLite backup API) and tantivy indexes
 * (`cp --reflink=always`) in a scratch dir. Never reads, copies or stats character PNGs.
 *
 * Usage:
 *   node scripts/bench-search.mjs --pick-words
 *   node scripts/bench-search.mjs [--keep] [--out <file>] [--runs <n>] [--page-size <n>] [--scratch <dir>]
 *                                 [--user-dir <dir>] [--skip-concurrency] [--timeout-min <n>]
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATES = ['the', 'you', 'and', 'her', 'his', 'she', 'girl', 'woman', 'man', 'friend', 'school', 'love', 'dark', 'magic', 'king', 'queen', 'princess', 'knight', 'dragon', 'vampire', 'witch', 'demon', 'angel', 'elf', 'goblin', 'werewolf', 'zombie', 'ghost', 'pirate', 'ninja', 'samurai', 'detective', 'robot', 'android', 'cyberpunk', 'alien', 'assassin', 'soldier', 'teacher', 'nurse', 'maid', 'mermaid', 'fox', 'cat', 'wolf', 'sword', 'forest', 'ocean', 'space', 'medieval', 'library', 'coffee', 'bakery', 'lighthouse', 'volcano', 'submarine', 'astronaut', 'archaeologist', 'glacier', 'saxophone', 'origami', 'zeppelin', 'kaleidoscope', 'marionette', 'quokka'];

// Tiers by description docFreq from the pick-words run on 2026-09-26 (numDocs 379,408): high = girl/the/love,
// mid = dragon/vampire/detective, low = saxophone/quokka, 2-letter prefix = dr, two-word = dark knight.
/** @type {string[]} */
const WORDS = ['girl', 'the', 'love', 'dragon', 'vampire', 'detective', 'saxophone', 'quokka', 'dr', 'dark knight'];

const PICK_FIELDS = ['name', 'description', 'first_mes', 'personality', 'scenario', 'tags', 'resolved_tags', 'creator'];
const BOOT_LOG_MARKER = '[metadata-chain] backfillActiveChatFromCards';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const opts = {
        pickWords: false,
        keep: false,
        out: null,
        runs: 5,
        pageSize: 50,
        scratch: '/mnt/ssd/st-bench',
        userDir: path.join(REPO_ROOT, 'data', 'default-user'),
        skipConcurrency: false,
        timeoutMin: 120,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        const nextInt = () => {
            const n = Number(next());
            if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} needs a positive integer`);
            return n;
        };
        switch (a) {
            case '--pick-words': opts.pickWords = true; break;
            case '--keep': opts.keep = true; break;
            case '--out': opts.out = path.resolve(next()); break;
            case '--runs': opts.runs = nextInt(); break;
            case '--page-size': opts.pageSize = nextInt(); break;
            case '--scratch': opts.scratch = path.resolve(next()); break;
            case '--user-dir': opts.userDir = path.resolve(next()); break;
            case '--skip-concurrency': opts.skipConcurrency = true; break;
            case '--timeout-min': opts.timeoutMin = nextInt(); break;
            default: throw new Error(`unknown argument: ${a}`);
        }
    }
    return opts;
}

// ---------------------------------------------------------------- helpers

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function median(values) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values, p) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * s.length);
    return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

const fmt = v => (v === null || v === undefined || Number.isNaN(v)) ? '-' : v.toFixed(1);

function printTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
    const line = cells => cells.map((c, i) => String(c).padStart(widths[i])).join('  ');
    console.log(line(headers));
    console.log(widths.map(w => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(line(r));
}

async function loadTantivy() {
    const mod = await import('@oxdev03/node-tantivy-binding');
    return mod.default ?? mod;
}

async function loadDatabase() {
    const mod = await import('better-sqlite3');
    return mod.default ?? mod;
}

function metaValue(db, key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

function maxSeq(db, table) {
    const row = db.prepare(`SELECT MAX(seq) AS m FROM ${table}`).get();
    return row.m ?? 0;
}

// ---------------------------------------------------------------- state for cleanup

const state = {
    opts: null,
    server: null,
    sseAbort: null,
    dbHandles: new Set(),
    cleanedUp: false,
    errored: false,
};

async function stopServer() {
    const server = state.server;
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    const killTimer = setTimeout(() => {
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }, 60_000);
    await exited;
    clearTimeout(killTimer);
}

function clearScratch(scratch) {
    if (!fs.existsSync(scratch)) return;
    for (const entry of fs.readdirSync(scratch)) {
        fs.rmSync(path.join(scratch, entry), { recursive: true, force: true });
    }
}

async function cleanup() {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    if (state.sseAbort) {
        try { state.sseAbort.abort(); } catch { /* already closed */ }
    }
    await stopServer();
    for (const db of state.dbHandles) {
        try { db.close(); } catch { /* already closed */ }
    }
    state.dbHandles.clear();
    const opts = state.opts;
    if (!opts) return;
    if (opts.keep) {
        if (state.errored) console.log(`server log: ${path.join(opts.scratch, 'server.log')}`);
    } else {
        clearScratch(opts.scratch);
    }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        state.errored = true;
        cleanup().finally(() => process.exit(1));
    });
}

// ---------------------------------------------------------------- safety

function safetyChecks(opts) {
    const dataDir = path.join(REPO_ROOT, 'data');
    if (isInside(opts.scratch, dataDir)) throw new Error(`scratch ${opts.scratch} is inside ${dataDir}`);
    if (isInside(opts.scratch, opts.userDir)) throw new Error(`scratch ${opts.scratch} is inside ${opts.userDir}`);
    const srcIndex = path.join(opts.userDir, 'search-index', 'characters-tantivy');
    const srcDev = fs.statSync(srcIndex).dev;
    const scratchDev = fs.existsSync(opts.scratch)
        ? fs.statSync(opts.scratch).dev
        : fs.statSync(path.dirname(opts.scratch)).dev;
    if (srcDev !== scratchDev) throw new Error(`scratch ${opts.scratch} is on a different device than ${srcIndex}`);
    if (!fs.existsSync(opts.scratch)) fs.mkdirSync(opts.scratch);
    if (fs.readdirSync(opts.scratch).length > 0) throw new Error(`scratch ${opts.scratch} is not empty`);
}

// ---------------------------------------------------------------- snapshot

function scratchUserDir(opts) {
    return path.join(opts.scratch, 'data', 'default-user');
}

async function snapshotDb(opts) {
    const Database = await loadDatabase();
    const src = path.join(opts.userDir, 'character-metadata.sqlite');
    const dest = path.join(scratchUserDir(opts), 'character-metadata.sqlite');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const t0 = performance.now();
    const srcDb = new Database(src, { readonly: true, fileMustExist: true });
    state.dbHandles.add(srcDb);
    try {
        await srcDb.backup(dest, { progress: () => 1e9 });
    } finally {
        srcDb.close();
        state.dbHandles.delete(srcDb);
    }
    const secs = (performance.now() - t0) / 1000;
    console.log(`db backup: ${secs.toFixed(1)}s, ${(fs.statSync(dest).size / 1e9).toFixed(2)} GB -> ${dest}`);
    return dest;
}

async function reflinkIndex(opts, name, { verify }) {
    const src = path.join(opts.userDir, 'search-index', name);
    const destParent = path.join(scratchUserDir(opts), 'search-index');
    const dest = path.join(destParent, name);
    fs.mkdirSync(destParent, { recursive: true });
    const attempts = verify ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        await execFileAsync('cp', ['--reflink=always', '-r', src, destParent]);
        if (!verify) return dest;
        try {
            const tantivy = await loadTantivy();
            const numDocs = tantivy.Index.open(dest).searcher().numDocs;
            if (!(numDocs > 0)) throw new Error(`numDocs = ${numDocs}`);
            console.log(`reflinked ${name} (attempt ${attempt}), numDocs ${numDocs}`);
            return dest;
        } catch (err) {
            console.log(`verify ${name} attempt ${attempt} failed: ${err.message}`);
            fs.rmSync(dest, { recursive: true, force: true });
        }
    }
    throw new Error(`could not get a valid copy of ${name} after ${attempts} attempts`);
}

async function printSnapshotNumbers(dbPath) {
    const Database = await loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    state.dbHandles.add(db);
    try {
        const numbers = {
            changes_max_seq: maxSeq(db, 'changes'),
            tantivy_char_index_seq: metaValue(db, 'tantivy_char_index_seq'),
            tag_name_changes_max_seq: maxSeq(db, 'tag_name_changes'),
            tantivy_char_index_tag_name_change_seq: metaValue(db, 'tantivy_char_index_tag_name_change_seq'),
            tantivy_char_index_schema_version: metaValue(db, 'tantivy_char_index_schema_version'),
        };
        for (const [k, v] of Object.entries(numbers)) console.log(`  ${k}: ${v}`);
        return numbers;
    } finally {
        db.close();
        state.dbHandles.delete(db);
    }
}

// ---------------------------------------------------------------- sort

function readSort(opts) {
    const raw = JSON.parse(fs.readFileSync(path.join(opts.userDir, 'settings', 'power_user.json'), 'utf8'));
    const sortField = raw.sort_field;
    const sortOrder = raw.sort_order;
    console.log(`settings: sort_field=${JSON.stringify(sortField)} sort_order=${JSON.stringify(sortOrder)}`);
    if (sortOrder === 'random') throw new Error('random default sort not supported by the bench');
    return { field: sortField, order: sortOrder === 'desc' ? 'desc' : 'asc' };
}

// ---------------------------------------------------------------- pick words

async function pickWords(indexDir) {
    const tantivy = await loadTantivy();
    const searcher = tantivy.Index.open(indexDir).searcher();
    const numDocs = searcher.numDocs;
    console.log(`numDocs: ${numDocs}`);
    const rows = CANDIDATES.map(word => {
        const freqs = PICK_FIELDS.map(field => searcher.docFreq(field, word));
        return { word, freqs };
    });
    const descIdx = PICK_FIELDS.indexOf('description');
    rows.sort((a, b) => b.freqs[descIdx] - a.freqs[descIdx]);
    // docFreq includes deleted docs and numDocs doesn't, so desc% can go over 100.
    printTable(
        ['word', ...PICK_FIELDS, 'desc%'],
        rows.map(r => [r.word, ...r.freqs, ((r.freqs[descIdx] / numDocs) * 100).toFixed(2)]),
    );
}

// ---------------------------------------------------------------- server

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (srv.address());
            srv.close(() => resolve(port));
        });
    });
}

function tailLog(logPath, n = 50) {
    try {
        const lines = fs.readFileSync(logPath, 'utf8').split('\n');
        return lines.slice(-n).join('\n');
    } catch (err) {
        return `(could not read ${logPath}: ${err.message})`;
    }
}

async function startServer(opts) {
    const port = await freePort();
    const logPath = path.join(opts.scratch, 'server.log');
    const logFd = fs.openSync(logPath, 'a');
    const args = [
        'server.js',
        '--dataRoot', path.join(opts.scratch, 'data'),
        '--configPath', path.join(opts.scratch, 'config.yaml'),
        '--globalExtensionsPath', path.join(opts.scratch, 'global-extensions'),
        '--port', String(port),
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ];
    state.server = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, SILLYTAVERN_PERFORMANCE_SEARCHTIMING: 'true' },
        stdio: ['ignore', logFd, logFd],
    });
    fs.closeSync(logFd);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + opts.timeoutMin * 60_000;
    try {
        for (;;) {
            if (state.server.exitCode !== null) throw new Error(`server exited with code ${state.server.exitCode}`);
            if (Date.now() > deadline) throw new Error('timed out waiting for the server to answer');
            try {
                const res = await fetch(`${base}/`);
                await res.arrayBuffer();
                break;
            } catch { /* not up yet */ }
            await sleep(1000);
        }
        console.log(`server answering on ${base}`);
        for (;;) {
            if (state.server.exitCode !== null) throw new Error(`server exited with code ${state.server.exitCode}`);
            if (Date.now() > deadline) throw new Error(`timed out waiting for "${BOOT_LOG_MARKER}" in server.log`);
            if (fs.readFileSync(logPath, 'utf8').includes(BOOT_LOG_MARKER)) break;
            await sleep(1000);
        }
        console.log('server boot chain reached backfillActiveChatFromCards');
    } catch (err) {
        console.log(`--- last 50 lines of ${logPath} ---\n${tailLog(logPath)}`);
        throw err;
    }
    return { base, logPath };
}

async function openSession(base) {
    const res = await fetch(`${base}/csrf-token`);
    const { token } = await res.json();
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { base, token, cookie };
}

function openSse(session) {
    const sse = { times: [] };
    const controller = new AbortController();
    state.sseAbort = controller;
    sse.done = (async () => {
        const res = await fetch(`${session.base}/api/characters/changes/stream`, {
            headers: { Cookie: session.cookie },
            signal: controller.signal,
        });
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                if (line.startsWith('data:')) sse.times.push(performance.now());
            }
        }
    })().catch(err => {
        if (err.name !== 'AbortError') console.log(`SSE stream ended: ${err.message}`);
    });
    return sse;
}

// ---------------------------------------------------------------- request

function parseServerTiming(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(',')) {
        const [name, ...params] = part.trim().split(';');
        if (!name) continue;
        const dur = params.map(p => p.trim()).find(p => p.startsWith('dur='));
        out[name.trim()] = dur ? Number(dur.slice(4)) : null;
    }
    return out;
}

function decodeHashesBinary(buf) {
    let o = 0;
    o += 1; // header flags
    o += 1; // backend
    o += 8; // seq
    const total = buf.readDoubleLE(o); o += 8;
    const count = buf.readUInt16LE(o); o += 2;
    const ids = [];
    for (let i = 0; i < count; i++) {
        const flags = buf.readUInt8(o); o += 1;
        const idLen = buf.readUInt16LE(o); o += 2;
        const id = buf.toString('utf8', o, o + idLen); o += idLen;
        o += 3 * 4 + 5 * 8;
        const chatLen = buf.readUInt16LE(o); o += 2;
        o += chatLen;
        ids.push({ id, isGroup: (flags & 1) === 1 });
    }
    return { total, count, ids };
}

async function query(session, word, shape) {
    const body = JSON.stringify({
        filter: { search: word, includeGroups: true },
        sort: shape.sort,
        page: 1,
        pageSize: shape.pageSize,
        want: ['hashes', 'total'],
    });
    const t0 = performance.now();
    const res = await fetch(`${session.base}/api/characters/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body,
    });
    const ab = await res.arrayBuffer();
    const e2e = performance.now() - t0;
    const record = { word, shape: shape.name, e2e, status: res.status, timing: parseServerTiming(res.headers.get('server-timing')) };
    const handler = record.timing.handler;
    if (typeof handler === 'number') {
        record.outside_handler = e2e - handler;
        const phaseSum = Object.entries(record.timing)
            .filter(([k, v]) => k !== 'handler' && typeof v === 'number')
            .reduce((s, [, v]) => s + v, 0);
        record.await_gaps = handler - phaseSum;
    } else {
        record.outside_handler = null;
        record.await_gaps = null;
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !contentType.startsWith('application/octet-stream')) {
        record.error = `status ${res.status}: ${Buffer.from(ab).toString('utf8')}`;
        return record;
    }
    const decoded = decodeHashesBinary(Buffer.from(ab));
    record.total = decoded.total;
    record.count = decoded.count;
    record.ids = decoded.ids;
    return record;
}

// ---------------------------------------------------------------- phases

async function waitCaughtUp({ dbPath, sse, deadline, targets }) {
    const Database = await loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    state.dbHandles.add(db);
    try {
        let caughtUpAt = null;
        for (;;) {
            if (Date.now() > deadline) throw new Error('timed out waiting for the catch-up');
            const changesMax = targets?.changesMax ?? maxSeq(db, 'changes');
            const tagMax = targets?.tagMax ?? maxSeq(db, 'tag_name_changes');
            const idxSeq = Number(metaValue(db, 'tantivy_char_index_seq') ?? -1);
            const tagSeq = Number(metaValue(db, 'tantivy_char_index_tag_name_change_seq') ?? -1);
            if (caughtUpAt === null && idxSeq >= changesMax && tagSeq >= tagMax) caughtUpAt = performance.now();
            if (caughtUpAt !== null && sse.times.some(t => t > caughtUpAt)) return performance.now();
            await sleep(1000);
        }
    } finally {
        db.close();
        state.dbHandles.delete(db);
    }
}

async function runConcurrency({ session, sse, dbPath, indexDir, primary, deadline, records }) {
    const Database = await loadDatabase();
    const tantivy = await loadTantivy();

    const probe = await query(session, WORDS[0], primary);
    if (probe.error) throw new Error(`concurrency probe query failed: ${probe.error}`);
    const deleteIds = probe.ids.filter(r => !r.isGroup).slice(0, 20).map(r => r.id);

    const db = new Database(dbPath, { fileMustExist: true });
    state.dbHandles.add(db);
    let T0;
    let targets;
    let upsertCount = 0;
    try {
        db.pragma('busy_timeout = 10000');
        const placeholders = deleteIds.map(() => '?').join(', ');
        const upsertIds = [];
        for (const row of db.prepare(`SELECT id FROM characters WHERE id NOT IN (${placeholders}) LIMIT 5000`).iterate(...deleteIds)) {
            upsertIds.push(row.id);
        }
        upsertCount = upsertIds.length;
        const insertUpsert = db.prepare('INSERT INTO changes (id, op, fields) VALUES (?, \'upsert\', NULL)');
        const delChar = db.prepare('DELETE FROM characters WHERE id = ?');
        const delTags = db.prepare('DELETE FROM character_tags WHERE character_id = ?');
        const delImport = db.prepare('DELETE FROM local_import_mtimes WHERE duplicate_of = ?');
        const insertDelete = db.prepare('INSERT INTO changes (id, op, fields) VALUES (?, \'delete\', NULL)');
        db.transaction(() => {
            for (const id of upsertIds) insertUpsert.run(id);
            for (const id of deleteIds) {
                delChar.run(id);
                delTags.run(id);
                delImport.run(id);
                insertDelete.run(id);
            }
        })();
        T0 = performance.now();
        targets = { changesMax: maxSeq(db, 'changes'), tagMax: maxSeq(db, 'tag_name_changes') };
    } finally {
        db.close();
        state.dbHandles.delete(db);
    }
    console.log(`concurrency burst: ${upsertCount} upserts + ${deleteIds.length} deletes committed`);

    let deleteVisibleMs = deleteIds.length === 0 ? 0 : null;
    let catchUpDoneMs = null;
    let stop = false;

    const queryLoop = (async () => {
        let i = 0;
        while (!stop) {
            const r = await query(session, WORDS[i % WORDS.length], primary);
            r.phase = 'concurrency';
            r.since_t0 = performance.now() - T0;
            records.push(r);
            i++;
        }
    })();

    const pollerLoop = (async () => {
        const pending = new Set(deleteIds);
        while (!stop && pending.size > 0) {
            if (Date.now() > deadline) throw new Error('timed out waiting for the deletes to reach the index');
            const index = tantivy.Index.open(indexDir);
            const searcher = index.searcher();
            for (const id of [...pending]) {
                const res = searcher.search(tantivy.Query.termQuery(index.schema, 'data', id), 1, true);
                if (res.count === 0) pending.delete(id);
            }
            if (pending.size === 0) {
                deleteVisibleMs = performance.now() - T0;
                break;
            }
            await sleep(100);
        }
    })();

    const catchUpLoop = (async () => {
        const doneAt = await waitCaughtUp({ dbPath, sse, deadline, targets });
        catchUpDoneMs = doneAt - T0;
    })();

    try {
        // queryLoop only settles here if a query throws.
        await Promise.race([Promise.all([pollerLoop, catchUpLoop]), queryLoop]);
    } finally {
        stop = true;
        await Promise.allSettled([queryLoop, pollerLoop, catchUpLoop]);
    }

    for (const word of WORDS) {
        const r = await query(session, word, primary);
        r.phase = 'after_concurrency';
        records.push(r);
    }

    return { deleteIds: deleteIds.length, upserts: upsertCount, deleteVisibleMs, catchUpDoneMs, T0 };
}

// ---------------------------------------------------------------- report

function reportGroups(records) {
    const groups = new Map();
    for (const r of records) {
        const key = `${r.phase}\u0000${r.shape}`;
        if (!groups.has(key)) groups.set(key, new Map());
        const byWord = groups.get(key);
        if (!byWord.has(r.word)) byWord.set(r.word, []);
        byWord.get(r.word).push(r);
    }
    for (const [key, byWord] of groups) {
        const [phase, shape] = key.split('\u0000');
        console.log(`\n== ${phase} / ${shape}`);
        const timingKeys = [...new Set([...byWord.values()].flat().flatMap(r => Object.keys(r.timing)))];
        const headers = ['word', 'n', 'first', 'median', 'max', ...timingKeys, 'outside_handler', 'await_gaps', 'errors'];
        const rows = [];
        for (const [word, rs] of byWord) {
            const e2es = rs.map(r => r.e2e);
            const medOf = get => median(rs.map(get).filter(v => typeof v === 'number'));
            rows.push([
                word, rs.length, fmt(e2es[0]), fmt(median(e2es)), fmt(Math.max(...e2es)),
                ...timingKeys.map(k => fmt(medOf(r => r.timing[k]))),
                fmt(medOf(r => r.outside_handler)), fmt(medOf(r => r.await_gaps)),
                rs.filter(r => r.error).length,
            ]);
        }
        printTable(headers, rows);
    }
}

// ---------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    state.opts = opts;
    if (!opts.pickWords && WORDS.length === 0) {
        console.error('WORDS is empty - run --pick-words first');
        return 1;
    }

    safetyChecks(opts);
    const indexDir = path.join(scratchUserDir(opts), 'search-index', 'characters-tantivy');

    if (opts.pickWords) {
        await reflinkIndex(opts, 'characters-tantivy', { verify: true });
        await pickWords(indexDir);
        return 0;
    }

    const dbPath = await snapshotDb(opts);
    await reflinkIndex(opts, 'characters-tantivy', { verify: true });
    await reflinkIndex(opts, 'groups-tantivy', { verify: false });
    console.log('snapshot:');
    const snapshot = await printSnapshotNumbers(dbPath);
    const settingsSort = readSort(opts);

    const shapes = {
        primary: { name: 'primary', sort: settingsSort, pageSize: opts.pageSize },
        search_sort: { name: 'search_sort', sort: { field: 'search' }, pageSize: opts.pageSize },
        sidebar: { name: 'sidebar', sort: { field: 'search' }, pageSize: 500 },
    };

    const { base } = await startServer(opts);
    const session = await openSession(base);
    const sse = openSse(session);
    const deadlineFrom = () => Date.now() + opts.timeoutMin * 60_000;

    /** @type {object[]} */
    const records = [];
    const push = (r, phase) => { r.phase = phase; records.push(r); return r; };

    const phaseAStart = performance.now();
    push(await query(session, WORDS[0], shapes.primary), 'cold_start');
    for (const word of WORDS) push(await query(session, word, shapes.primary), 'during_initial_catchup');
    const caughtUpAt = await waitCaughtUp({ dbPath, sse, deadline: deadlineFrom() });
    const initialCatchUpMs = caughtUpAt - phaseAStart;
    console.log(`initial catch-up done after ${fmt(initialCatchUpMs)} ms`);
    for (const shape of Object.values(shapes)) {
        for (const word of WORDS) {
            for (let i = 0; i < opts.runs; i++) push(await query(session, word, shape), 'steady');
        }
    }
    let concurrency = null;
    if (!opts.skipConcurrency) {
        concurrency = await runConcurrency({ session, sse, dbPath, indexDir, primary: shapes.primary, deadline: deadlineFrom(), records });
    }

    reportGroups(records);

    console.log('');
    console.log(`initial catch-up (phase C): ${fmt(initialCatchUpMs)} ms`);
    if (concurrency) {
        const during = records.filter(r => r.phase === 'concurrency').map(r => r.e2e);
        console.log(`concurrency: ${during.length} queries during catch-up, median ${fmt(median(during))}, p95 ${fmt(percentile(during, 95))}, max ${fmt(during.length ? Math.max(...during) : null)} ms`);
        console.log(`concurrency: ${concurrency.deleteIds} deletes visible after ${fmt(concurrency.deleteVisibleMs)} ms, catch-up done after ${fmt(concurrency.catchUpDoneMs)} ms`);
    }

    const errors = records.filter(r => r.error);
    for (const r of errors) console.log(`error: ${r.phase}/${r.shape}/${r.word}: ${r.error}`);

    const slow = new Map();
    const failedRequests = new Set();
    for (const r of records) {
        if (r.phase !== 'steady' || r.shape !== 'primary') continue;
        if (r.error) failedRequests.add(`${r.word}: error ${r.status}`);
        else if (r.e2e >= 100) slow.set(r.word, Math.max(slow.get(r.word) ?? 0, r.e2e));
    }
    const failures = [...[...slow].map(([w, m]) => `${w} (max ${fmt(m)} ms)`), ...failedRequests];
    const pass = failures.length === 0;
    console.log(pass ? 'PASS' : `FAIL ${failures.join(', ')}`);

    if (opts.out) {
        const raw = records.map(r => ({ ...r, ids: undefined }));
        fs.writeFileSync(opts.out, JSON.stringify({
            snapshot,
            sort: settingsSort,
            pageSize: opts.pageSize,
            initialCatchUpMs,
            concurrency,
            records: raw,
        }, null, 2));
        console.log(`raw records: ${opts.out}`);
    }

    return pass && errors.length === 0 ? 0 : 1;
}

let exitCode = 1;
try {
    exitCode = await main();
} catch (err) {
    state.errored = true;
    console.error(err);
    exitCode = 1;
} finally {
    await cleanup();
}
process.exit(exitCode);
