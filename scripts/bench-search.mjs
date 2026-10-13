#!/usr/bin/env node
/* eslint-env node */
/**
 * Search benchmark: times `POST /api/characters/query` for every request shape the character list can send.
 *
 * The live run sends them to a running server (`--url`) over HTTP: read-only, it opens and copies nothing. Each
 * (shape, word) is sent once, then WARM_RUNS times more, back to back, each timed end to end; each line of `--out` is
 * one (shape, word). `--out` gets a `{"type":"header"}` line first and a `{"type":"end"}` line once every shape has run.
 *
 * `--concurrency` is a separate run that writes, on a made-up library in `--scratch` and never on live: see
 * concurrencyRun(). `--out` then gets one JSON document.
 *
 * Usage:
 *   node scripts/bench-search.mjs --url <server> [--out <raw.jsonl>] [--only <regex on shape id>]
 *   node scripts/bench-search.mjs --list --url <server>
 *   node scripts/bench-search.mjs --report <raw.jsonl>
 *   node scripts/bench-search.mjs --concurrency --scratch <empty dir> [--cards <n>] [--keep] [--timeout-min <n>]
 *                                 [--out <raw.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

// Tiers by description docFreq on the live library (2026-09-26, 379,408 cards): high = girl/the/love,
// mid = dragon/vampire/detective, low = saxophone/quokka, 2-letter prefix = dr, two-word = dark knight.
/** @type {string[]} */
const WORDS = ['girl', 'the', 'love', 'dragon', 'vampire', 'detective', 'saxophone', 'quokka', 'dr', 'dark knight'];

/** Requests after the first, for each (shape, word). */
const WARM_RUNS = 5;
const PAGE_SIZE = 50;
const DEEP_PAGE = 100;
const DROPDOWN_PAGE_SIZE = 500;
/** The random sort's seed, the same in every run so shapes line up across runs. */
const RANDOM_SEED = 1234567890;
/** A shape fails when its first requests' p50 or its repeats' max is over this many ms. */
const LIMIT_MS = 100;
/** The concurrency run's made-up library, in cards. */
const DEFAULT_CARDS = 20_000;
/** The concurrency run's burst: tag assignments and deletes, sent this many at a time. */
const BURST_ASSIGNS = 5000;
const BURST_DELETES = 20;
const BURST_IN_FLIGHT = 8;

const NOTE = 'Note: "Show only groups" and "Show only folders" send the same body as no filter, and opening a folder'
    + ' sends tags.include:[folderTagId], the same shape as 1 included tag, so neither is a shape of its own.';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const opts = {
        mode: 'run',
        report: null,
        out: null,
        only: null,
        url: null,
        scratch: null,
        cards: DEFAULT_CARDS,
        keep: false,
        timeoutMin: 120,
    };
    const given = new Set();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        const whole = () => {
            const v = Number(next());
            if (!Number.isInteger(v) || v <= 0) throw new Error(`${a} needs a positive whole number`);
            return v;
        };
        given.add(a);
        switch (a) {
            case '--help': opts.mode = 'help'; break;
            case '--concurrency': opts.mode = 'concurrency'; break;
            case '--scratch': opts.scratch = path.resolve(next()); break;
            case '--cards': opts.cards = whole(); break;
            case '--keep': opts.keep = true; break;
            case '--timeout-min': opts.timeoutMin = whole(); break;
            case '--list': opts.mode = 'list'; break;
            case '--report': opts.mode = 'report'; opts.report = path.resolve(next()); break;
            case '--out': opts.out = path.resolve(next()); break;
            case '--only': opts.only = new RegExp(next()); break;
            case '--url': opts.url = next().replace(/\/+$/, ''); break;
            default: throw new Error(`unknown argument: ${a}`);
        }
    }
    const allowed = {
        'run': ['--url', '--out', '--only'],
        'list': ['--list', '--url'],
        'report': ['--report'],
        'help': ['--help'],
        'concurrency': ['--concurrency', '--scratch', '--cards', '--keep', '--timeout-min', '--out'],
    }[opts.mode];
    const extra = [...given].filter(a => !allowed.includes(a));
    if (extra.length > 0) throw new Error(`${extra.join(', ')} can't be used with ${opts.mode === 'run' ? 'the live run' : `--${opts.mode}`}`);
    if ((opts.mode === 'run' || opts.mode === 'list') && opts.url === null) throw new Error('--url <server> is needed: the running server to send the queries to');
    if (opts.mode === 'concurrency' && opts.scratch === null) throw new Error('--concurrency needs --scratch <empty dir>');
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

function gitInfo() {
    const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
    const head = git('rev-parse', 'HEAD').trim();
    const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
    return { head, dirty };
}

// ---------------------------------------------------------------- the server

/**
 * A session on a server: its CSRF token and cookie, as the page gets them.
 * @param {string} base
 */
async function openSession(base) {
    const res = await fetch(`${base}/csrf-token`);
    if (!res.ok) throw new Error(`${base}/csrf-token answered ${res.status}`);
    const { token } = await res.json();
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { base, token, cookie };
}

/**
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {string} route
 * @param {object} body
 */
function post(session, route, body) {
    return fetch(`${session.base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body: JSON.stringify(body),
    });
}

/**
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {string} route
 * @param {object} body
 */
async function postJson(session, route, body) {
    const res = await post(session, route, body);
    if (!res.ok) throw new Error(`${route} answered ${res.status}: ${await res.text()}`);
    return res.json();
}

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

/** The page's own decoder of the hash-mode answer. */
async function hashDecoder() {
    const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'public', 'scripts', 'query-hashes-binary.js')).href);
    return mod.deserializeQueryHashesBinary;
}

/**
 * One timed POST /api/characters/query, end to end: from before the fetch to after the body is read.
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {object} body
 * @param {(buffer: ArrayBuffer) => any} decode
 */
async function timedQuery(session, body, decode) {
    const t0 = performance.now();
    const res = await post(session, '/api/characters/query', body);
    const ab = await res.arrayBuffer();
    const e2e = performance.now() - t0;
    const timing = parseServerTiming(res.headers.get('server-timing'));
    const handler = typeof timing.handler === 'number' ? timing.handler : null;
    const phaseSum = Object.entries(timing)
        .filter(([k, v]) => k !== 'handler' && typeof v === 'number')
        .reduce((s, [, v]) => s + v, 0);
    const record = {
        e2e,
        status: res.status,
        timing,
        handler,
        outside_handler: handler === null ? null : e2e - handler,
        await_gaps: handler === null ? null : handler - phaseSum,
    };
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status !== 200 || !contentType.startsWith('application/octet-stream')) {
        record.error = `status ${res.status}, ${contentType || 'no content-type'}: ${Buffer.from(ab).toString('utf8')}`;
        return record;
    }
    const decoded = decode(ab);
    record.total = decoded.total ?? null;
    record.approxTotal = decoded.totalApprox;
    record.count = decoded.hashRows.length;
    record.seq = decoded.seq;
    record.ids = decoded.hashRows.map(r => ({ id: r.id, isGroup: r.isGroup }));
    return record;
}

// ---------------------------------------------------------------- shapes

// Filter keys go in the order the client sends them: search, tags, fav, includeGroups (shapes.md).
const FILTERS = [
    { id: 'none', build: () => ({}) },
    { id: 'fav', build: () => ({ fav: true }) },
    { id: 'notfav', build: () => ({ fav: false }) },
    { id: 'tag1', build: tags => ({ tags: { include: [tags[0]], exclude: [], mode: 'and' } }) },
    { id: 'tag3', build: tags => ({ tags: { include: [tags[0], tags[1], tags[2]], exclude: [], mode: 'and' } }) },
    { id: 'xtag1', build: tags => ({ tags: { include: [], exclude: [tags[0]], mode: 'and' } }) },
];

// The sort dropdown's options (public/index.html #character_sort_order), without Search.
const LIST_SORTS = [
    { id: 'name-asc', sort: { field: 'name', order: 'asc' } },
    { id: 'name-desc', sort: { field: 'name', order: 'desc' } },
    { id: 'create_date-desc', sort: { field: 'create_date', order: 'desc' } },
    { id: 'create_date-asc', sort: { field: 'create_date', order: 'asc' } },
    { id: 'fav-desc', sort: { field: 'fav', order: 'desc' } },
    { id: 'date_last_chat-desc', sort: { field: 'date_last_chat', order: 'desc' } },
    { id: 'chat_size-desc', sort: { field: 'chat_size', order: 'desc' } },
    { id: 'chat_size-asc', sort: { field: 'chat_size', order: 'asc' } },
    { id: 'data_size-desc', sort: { field: 'data_size', order: 'desc' } },
    { id: 'data_size-asc', sort: { field: 'data_size', order: 'asc' } },
    { id: 'random', sort: { field: 'random', order: 'asc', seed: RANDOM_SEED } },
];

/**
 * @typedef {object} Shape
 * @property {string} id
 * @property {boolean} hasTerm Whether it runs once per word of WORDS.
 * @property {(word: string|null) => object} body
 */

/**
 * Every shape, in run order. Ids don't depend on the library, so runs line up by id.
 * @param {{ tagIds: string[], searchOrder: 'asc'|'desc' }} params
 * @returns {Shape[]}
 */
function buildShapes({ tagIds, searchOrder }) {
    const sorts = [...LIST_SORTS, { id: 'search', sort: { field: 'search', order: searchOrder } }];
    /** @type {Shape[]} */
    const shapes = [];
    for (const filter of FILTERS) {
        for (const { id: sortId, sort } of sorts) {
            for (const hasTerm of [false, true]) {
                if (sortId === 'search' && !hasTerm) continue;
                for (const page of [1, DEEP_PAGE]) {
                    shapes.push({
                        id: `${filter.id}/${sortId}/${hasTerm ? 'term' : 'noterm'}/p${page}`,
                        hasTerm,
                        body: word => ({
                            filter: { ...(hasTerm ? { search: word } : {}), ...filter.build(tagIds), includeGroups: true },
                            sort,
                            page,
                            pageSize: PAGE_SIZE,
                            want: ['hashes', 'total'],
                        }),
                    });
                }
            }
        }
    }
    // The search dropdown (shapes.md S4). Its fav filter goes after includeGroups, as the client sends it.
    for (const fav of [false, true]) {
        shapes.push({
            id: `dropdown/${fav ? 'fav' : 'none'}`,
            hasTerm: true,
            body: word => ({
                filter: { search: word, includeGroups: true, ...(fav ? { fav: true } : {}) },
                sort: { field: 'search' },
                page: 1,
                pageSize: DROPDOWN_PAGE_SIZE,
                want: ['hashes', 'total'],
            }),
        });
    }
    return shapes;
}

/**
 * The three tags most characters and groups carry, from the server's tag list.
 * @param {{ base: string, token: string, cookie: string }} session
 * @returns {Promise<{ id: string, name: string|null, count: number }[]>}
 */
async function readTopTags(session) {
    const page = await postJson(session, '/api/tags/query', { filter: { used: true }, sort: { field: 'by_entries' }, pageSize: 3, counts: true });
    const top = page.rows.map(r => ({ id: r.id, name: r.name ?? null, count: page.counts?.[r.id] ?? 0 }));
    if (top.length < 3) throw new Error(`the library has ${top.length} used tags; the tag shapes need 3`);
    return top;
}

/**
 * The search sort's order as the client sends it: "desc" when power_user.sort_order is "desc", else "asc".
 * @param {{ base: string, token: string, cookie: string }} session
 * @returns {Promise<'asc'|'desc'>}
 */
async function readSearchOrder(session) {
    const answer = await postJson(session, '/api/settings/get', {});
    const settings = typeof answer.settings === 'string' ? JSON.parse(answer.settings) : answer.settings;
    return settings?.power_user?.sort_order === 'desc' ? 'desc' : 'asc';
}

async function loadShapes(session) {
    const tags = await readTopTags(session);
    const shapes = buildShapes({ tagIds: tags.map(t => t.id), searchOrder: await readSearchOrder(session) });
    return { tags, shapes };
}

function describeTags(tags) {
    return tags.map((t, i) => `t${i + 1} = ${t.id} (${t.name === null ? 'no name' : JSON.stringify(t.name)}, ${t.count} carriers)`).join('; ');
}

// ---------------------------------------------------------------- --list

async function listShapes(opts) {
    const { shapes } = await loadShapes(await openSession(opts.url));
    console.log(`${shapes.length} shapes. A body with "<word>" runs once for each of: ${WORDS.join(', ')}.`);
    for (const shape of shapes) console.log(`${shape.id}  ${JSON.stringify(shape.body(shape.hasTerm ? '<word>' : null))}`);
}

// ---------------------------------------------------------------- live run

async function liveRun(opts) {
    if (opts.out && isInside(opts.out, path.join(REPO_ROOT, 'data'))) {
        throw new Error(`--out ${opts.out} is inside the data dir; the bench writes nothing there`);
    }
    if (opts.out && fs.existsSync(opts.out)) throw new Error(`--out ${opts.out} already exists`);
    const session = await openSession(opts.url);
    const decode = await hashDecoder();
    const startedAt = new Date().toISOString();
    const git = gitInfo();
    const { tags, shapes: allShapes } = await loadShapes(session);
    const shapes = opts.only ? allShapes.filter(s => opts.only.test(s.id)) : allShapes;
    if (shapes.length === 0) throw new Error(`--only ${opts.only} matches no shape id (see --list)`);
    const header = { type: 'header', time: startedAt, url: opts.url, checkout: REPO_ROOT, head: git.head, dirty: git.dirty, tags, seed: RANDOM_SEED, words: WORDS };

    // Opened before the first request, so an existing file is refused before anything runs. The header line goes
    // first and the end line last, so `--report` can print the header and tell an interrupted run by its missing end.
    const outFd = opts.out ? fs.openSync(opts.out, 'wx') : null;
    const total = shapes.reduce((n, s) => n + (s.hasTerm ? WORDS.length : 1), 0);
    /** @type {object[]} */
    const lines = [];
    let end;
    try {
        if (outFd !== null) fs.writeSync(outFd, `${JSON.stringify(header)}\n`);
        for (const shape of shapes) {
            for (const word of shape.hasTerm ? WORDS : [null]) {
                const body = shape.body(word);
                const requests = [];
                for (let i = 0; i < 1 + WARM_RUNS; i++) {
                    const r = await timedQuery(session, body, decode);
                    delete r.ids;
                    requests.push(r);
                }
                const line = { shape: shape.id, word, body, requests };
                lines.push(line);
                if (outFd !== null) fs.writeSync(outFd, `${JSON.stringify(line)}\n`);
                console.error(`${new Date().toISOString()} [${lines.length}/${total}] ${shape.id} ${word ?? '-'} first=${fmt(requests[0].e2e)}ms`);
            }
        }
        end = { type: 'end', time: new Date().toISOString() };
        if (outFd !== null) fs.writeSync(outFd, `${JSON.stringify(end)}\n`);
    } finally {
        if (outFd !== null) fs.closeSync(outFd);
    }

    printHeader(header, end);
    console.log('');
    const pass = printReport(lines);
    console.log('');
    console.log(NOTE);
    if (opts.out) console.log(`raw: ${opts.out}`);
    return pass ? 0 : 1;
}

// ---------------------------------------------------------------- report

/**
 * Prints the run's header from its header line and end line. `end` is undefined when the run didn't get there.
 * @param {object|undefined} header
 * @param {object|undefined} end
 */
function printHeader(header, end) {
    if (!header) {
        console.log('header: not in the file');
    } else {
        console.log(`time: ${header.time}`);
        console.log(`server: ${header.url}`);
        console.log(`checkout: ${header.checkout} at ${header.head}, ${header.dirty.length === 0 ? 'clean' : `dirty (${header.dirty.length} files):`}`);
        for (const f of header.dirty) console.log(`  ${f}`);
        console.log(`tags: ${describeTags(header.tags)}`);
        console.log(`random seed: ${header.seed}`);
        console.log(`words: ${header.words.join(', ')}`);
    }
    console.log(`finished: ${end ? end.time : 'not reached'}`);
}

/**
 * A sample's phases: its Server-Timing entries other than `handler`, plus outside_handler and await_gaps.
 * @returns {Map<string, number>}
 */
function samplePhases(sample) {
    const phases = new Map();
    for (const [name, ms] of Object.entries(sample.timing ?? {})) {
        if (name !== 'handler' && typeof ms === 'number') phases.set(name, ms);
    }
    if (typeof sample.outside_handler === 'number') phases.set('outside_handler', sample.outside_handler);
    if (typeof sample.await_gaps === 'number') phases.set('await_gaps', sample.await_gaps);
    return phases;
}

/** The phase with the largest median over `samples`; a sample without a phase spent 0 ms in it. */
function dominantByMedian(samples) {
    const all = samples.map(samplePhases);
    const names = new Set(all.flatMap(p => [...p.keys()]));
    let best = null;
    for (const name of names) {
        const m = median(all.map(p => p.get(name) ?? 0));
        if (best === null || m > best.ms) best = { name, ms: m };
    }
    return best?.name ?? '-';
}

/** The largest phase of the sample with the largest e2e. */
function dominantOfMax(samples) {
    const max = samples.reduce((a, b) => (b.e2e > a.e2e ? b : a));
    let best = null;
    for (const [name, ms] of samplePhases(max)) {
        if (best === null || ms > best.ms) best = { name, ms };
    }
    return best?.name ?? '-';
}

/**
 * Prints one row per shape from raw lines, pooling a shape's words, then every errored request.
 * @param {object[]} lines
 * @returns {boolean} whether every shape passed and nothing errored
 */
function printReport(lines) {
    /** @type {Map<string, { first: object[], repeat: object[], errors: string[] }>} */
    const byShape = new Map();
    for (const line of lines) {
        if (!byShape.has(line.shape)) byShape.set(line.shape, { first: [], repeat: [], errors: [] });
        const s = byShape.get(line.shape);
        const where = `${line.shape} ${line.word ?? '-'}`;
        // Errored requests stay out of the timings: a fast 500 would pull the p50 down, a hung one the max up.
        line.requests.forEach((r, i) => {
            if (r.error) s.errors.push(`${where} ${i === 0 ? 'first' : `repeat ${i}`}: ${r.error}`);
            else (i === 0 ? s.first : s.repeat).push(r);
        });
    }

    const rows = [];
    const errors = [];
    let allPass = true;
    for (const [id, s] of byShape) {
        const firstE2e = s.first.map(r => r.e2e);
        const repeatE2e = s.repeat.map(r => r.e2e);
        const firstP50 = median(firstE2e);
        const repeatMax = repeatE2e.length ? Math.max(...repeatE2e) : null;
        const firstFail = firstP50 !== null && firstP50 > LIMIT_MS;
        const repeatFail = repeatMax !== null && repeatMax > LIMIT_MS;
        const marks = [];
        if (firstFail || repeatFail) marks.push('FAIL');
        if (s.errors.length > 0) marks.push('ERROR');
        if (marks.length > 0) allPass = false;
        const dominant = [];
        if (firstFail) dominant.push(`first: ${dominantByMedian(s.first)}`);
        if (repeatFail) dominant.push(`repeat: ${dominantOfMax(s.repeat)}`);
        rows.push([
            id, `${s.first.length}/${s.repeat.length}`,
            fmt(firstP50), fmt(firstE2e.length ? Math.max(...firstE2e) : null),
            fmt(median(repeatE2e)), fmt(repeatMax),
            marks.length ? marks.join(' ') : 'PASS', dominant.join(', ') || '-',
        ]);
        errors.push(...s.errors);
    }
    printTable(['shape', 'n first/repeat', 'first p50', 'first max', 'repeat p50', 'repeat max', 'result', 'dominant phase'], rows);
    if (errors.length > 0) {
        console.log('');
        console.log(`errors (${errors.length}):`);
        for (const e of errors) console.log(`  ${e}`);
    }
    return allPass;
}

function reportFromFile(file) {
    const parsed = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => {
        try {
            return JSON.parse(l);
        } catch (err) {
            throw new Error(`${file}:${i + 1} is not JSON: ${err.message}`);
        }
    });
    let header;
    let end;
    const lines = [];
    parsed.forEach((line, i) => {
        if (line.type === 'header') {
            if (i !== 0) throw new Error(`${file}:${i + 1} is a header line, but only the first line may be one`);
            header = line;
        } else if (line.type === 'end') {
            if (i !== parsed.length - 1) throw new Error(`${file}:${i + 1} is an end line, but only the last line may be one`);
            end = line;
        } else {
            lines.push(line);
        }
    });
    printHeader(header, end);
    console.log('');
    return printReport(lines) ? 0 : 1;
}

// ---------------------------------------------------------------- concurrency run

// The concurrency run times queries while a burst of commits goes on (tag assignments and character deletes through
// the routes), to show what writes cost the queries beside them. The made-up cards carry only the searched fields, so
// upstream's card routes refuse to edit them (no `spec`); assigning a tag is a write every character takes. It writes, so it never runs on the live library: it runs on a
// made-up library the engine's search bench generates (`engine/examples/search.rs --real`, the synthetic text of
// scripts/bench-search-synth.mjs) in `--scratch`, served by this checkout's server on a free port.
//
// Scratch layout: data/ (the data root, the library's store in data/default-user/store), config.yaml (the default
// config, made by the server on its first start), global-extensions/, server.log.

const state = {
    server: null,
    scratch: null,
    keep: false,
    cleanedUp: false,
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

/** Stops the server and clears the scratch dir unless `--keep`. */
async function cleanupConcurrency() {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    await stopServer();
    if (state.scratch === null) return;
    if (state.keep) {
        console.log(`kept: ${state.scratch} (server log: ${path.join(state.scratch, 'server.log')})`);
    } else {
        clearScratch(state.scratch);
        console.log(`cleared: ${state.scratch}`);
    }
}

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

/**
 * Checks `--scratch`: outside the repo's data dir (by real path), and empty or missing. Creates it when missing.
 * Returns its real path.
 */
function checkScratchDir(opts) {
    const liveData = path.join(REPO_ROOT, 'data');
    let scratch = path.resolve(opts.scratch);
    if (fs.existsSync(scratch)) scratch = fs.realpathSync(scratch);
    else scratch = path.join(fs.realpathSync(path.dirname(scratch)), path.basename(scratch));
    const liveReal = fs.existsSync(liveData) ? fs.realpathSync(liveData) : liveData;
    if (isInside(scratch, liveReal)) throw new Error(`--scratch ${scratch} is inside the data dir ${liveReal}`);
    if (isInside(liveReal, scratch)) throw new Error(`--scratch ${scratch} contains the data dir ${liveReal}`);
    if (!fs.existsSync(scratch)) fs.mkdirSync(scratch);
    if (fs.readdirSync(scratch).length > 0) throw new Error(`--scratch ${scratch} is not empty`);
    return scratch;
}

/**
 * Writes the made-up library's store at `dir` with the engine's search bench (a release build of the crate's
 * example; the engine's own build needs the Rust toolchain).
 * @param {string} dir
 * @param {number} cards
 */
function generateLibrary(dir, cards) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('cargo', ['run', '--release', '--features', 'measure', '--example', 'search', '--', dir, 'synth', String(cards), '--real', '--bulk', '--no-check'], {
        cwd: path.join(REPO_ROOT, 'engine'),
        stdio: ['ignore', 'ignore', 'inherit'],
    });
}

/** Starts server.js from this checkout on the scratch library, on a free port (never 8000). */
async function startServer(opts) {
    const port = await freePort();
    if (port === 8000) throw new Error('the free port picked was 8000; the bench never uses it');
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
    } catch (err) {
        console.log(`--- last 50 lines of ${logPath} ---\n${tailLog(logPath)}`);
        throw err;
    }
    return { base, logPath };
}

/**
 * The made-up library's characters by name, up to `n` of them.
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {number} n
 * @param {(buffer: ArrayBuffer) => any} decode
 * @returns {Promise<string[]>}
 */
async function characterIds(session, n, decode) {
    /** @type {string[]} */
    const ids = [];
    for (let page = 1; ids.length < n; page++) {
        const r = await timedQuery(session, { filter: {}, sort: { field: 'name', order: 'asc' }, page, pageSize: 500, want: ['hashes'] }, decode);
        if (r.error) throw new Error(`listing the characters failed: ${r.error}`);
        ids.push(...r.ids.filter(x => !x.isGroup).map(x => x.id));
        if (r.count < 500) break;
    }
    return ids.slice(0, n);
}

/**
 * The burst: BURST_ASSIGNS tag assignments (the most used tag, to characters that may not carry it) and BURST_DELETES
 * deletes (the first word's first page), BURST_IN_FLIGHT at a time, while queries go back to back, cycling the words.
 */
async function runConcurrency({ session, primary, run, decode }) {
    const records = run.records;
    const probe = await timedQuery(session, primaryBody(primary, WORDS[0]), decode);
    if (probe.error) throw new Error(`concurrency probe query failed: ${probe.error}`);
    const deleteIds = probe.ids.filter(r => !r.isGroup).slice(0, BURST_DELETES).map(r => r.id);
    const assignIds = (await characterIds(session, BURST_ASSIGNS + deleteIds.length, decode)).filter(id => !deleteIds.includes(id)).slice(0, BURST_ASSIGNS);
    const [tag] = await readTopTags(session);
    const result = { assigns: assignIds.length, deletes: deleteIds.length, failedWrites: 0, burstMs: null, deletesGoneMs: null };
    run.concurrency = result;

    const writes = [
        ...assignIds.map(id => () => post(session, '/api/tags/assign', { id, tagId: tag.id })),
        ...deleteIds.map(avatar => () => post(session, '/api/characters/delete', { avatar_url: avatar, delete_chats: false })),
    ];
    const T0 = performance.now();
    let stop = false;
    const writer = (async () => {
        let next = 0;
        await Promise.all(Array.from({ length: BURST_IN_FLIGHT }, async () => {
            while (next < writes.length) {
                const res = await writes[next++]();
                await res.arrayBuffer();
                if (!res.ok) result.failedWrites++;
            }
        }));
        result.burstMs = performance.now() - T0;
    })();
    const queryLoop = (async () => {
        let i = 0;
        while (!stop) {
            const word = WORDS[i % WORDS.length];
            const r = await timedQuery(session, primaryBody(primary, word), decode);
            r.word = word;
            r.phase = 'concurrency';
            r.since_t0 = performance.now() - T0;
            if (word === WORDS[0] && result.deletesGoneMs === null && result.burstMs !== null && !r.error && !r.ids.some(x => deleteIds.includes(x.id))) {
                result.deletesGoneMs = r.since_t0;
            }
            delete r.ids;
            records.push(r);
            i++;
        }
    })();
    try {
        await writer;
        // A last cycle of queries after the burst, so the first word is read once the deletes are in.
        const seen = records.length;
        while (records.length < seen + WORDS.length) await sleep(10);
    } finally {
        stop = true;
        await queryLoop;
    }
    for (const word of WORDS) {
        const r = await timedQuery(session, primaryBody(primary, word), decode);
        delete r.ids;
        r.word = word;
        r.phase = 'after_concurrency';
        records.push(r);
    }
}

function primaryBody(primary, word) {
    return { filter: { search: word, includeGroups: true }, sort: primary.sort, page: 1, pageSize: primary.pageSize, want: ['hashes', 'total'] };
}

/**
 * Prints the concurrency run's result from whatever `run` holds, so an errored run still reports what it got.
 * @returns {boolean} whether the max during the burst is within LIMIT_MS and no request errored
 */
function reportConcurrency(run) {
    console.log(`made-up library: ${run.cards} cards`);
    console.log(`sort: ${JSON.stringify(run.sort)}, ${PAGE_SIZE} a page, words: ${WORDS.join(', ')}`);
    const errors = run.records.filter(r => r.error);
    const during = run.records.filter(r => r.phase === 'concurrency' && !r.error).map(r => r.e2e);
    const max = during.length ? Math.max(...during) : null;
    const c = run.concurrency;
    if (c) {
        console.log(`burst: ${c.assigns} tag assignments + ${c.deletes} deletes, ${BURST_IN_FLIGHT} in flight, done after ${fmt(c.burstMs)} ms (${c.failedWrites} refused)`);
        console.log(`queries during the burst: ${during.length}, median ${fmt(median(during))} ms, p95 ${fmt(percentile(during, 95))} ms, max ${fmt(max)} ms`);
        console.log(`deletes gone from the first word's page after ${fmt(c.deletesGoneMs)} ms`);
    } else {
        console.log('burst: not reached');
    }
    for (const r of errors) console.log(`error: ${r.phase}/${r.word}: ${r.error}`);

    const marks = [];
    if (max !== null && max > LIMIT_MS) marks.push(`FAIL (max ${fmt(max)} ms > ${LIMIT_MS} ms)`);
    if (errors.length > 0) marks.push(`ERROR (${errors.length} requests)`);
    if (c && c.failedWrites > 0) marks.push(`ERROR (${c.failedWrites} writes refused)`);
    if (!c || c.burstMs === null || c.deletesGoneMs === null) marks.push('INCOMPLETE');
    console.log(marks.length ? marks.join(' ') : 'PASS');
    return marks.length === 0;
}

async function concurrencyRun(opts) {
    if (opts.out && isInside(opts.out, path.join(REPO_ROOT, 'data'))) throw new Error(`--out ${opts.out} is inside the data dir; the bench writes nothing there`);
    if (opts.out && isInside(opts.out, opts.scratch)) throw new Error(`--out ${opts.out} is inside --scratch, which is cleared`);
    if (opts.out && fs.existsSync(opts.out)) throw new Error(`--out ${opts.out} already exists`);
    opts.scratch = checkScratchDir(opts);
    state.scratch = opts.scratch;
    state.keep = opts.keep;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            cleanupConcurrency().finally(() => process.exit(1));
        });
    }

    const git = gitInfo();
    const sort = { field: 'name', order: 'asc' };
    const run = {
        type: 'concurrency',
        time: new Date().toISOString(),
        checkout: REPO_ROOT,
        head: git.head,
        dirty: git.dirty,
        cards: opts.cards,
        words: WORDS,
        sort,
        pageSize: PAGE_SIZE,
        concurrency: null,
        /** @type {object[]} */
        records: [],
    };
    const outFd = opts.out ? fs.openSync(opts.out, 'wx') : null;
    let pass = false;
    try {
        try {
            console.log(`generating ${opts.cards} cards`);
            generateLibrary(path.join(opts.scratch, 'data', 'default-user', 'store'), opts.cards);
            const { base } = await startServer(opts);
            const session = await openSession(base);
            await runConcurrency({ session, primary: { sort, pageSize: PAGE_SIZE }, run, decode: await hashDecoder() });
        } catch (err) {
            console.error(err);
            run.error = err?.stack ?? String(err);
        }
        console.log('');
        pass = reportConcurrency(run) && !run.error;
        if (outFd !== null) {
            fs.writeSync(outFd, JSON.stringify(run, null, 2));
            console.log(`raw: ${opts.out}`);
        }
    } finally {
        if (outFd !== null) fs.closeSync(outFd);
        await cleanupConcurrency();
    }
    return pass ? 0 : 1;
}

// ---------------------------------------------------------------- main

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    switch (opts.mode) {
        case 'list':
            await listShapes(opts);
            return 0;
        case 'report':
            return reportFromFile(opts.report);
        case 'help':
            console.log(fs.readFileSync(SCRIPT_PATH, 'utf8').split('\n').slice(1).join('\n').match(/\/\*\*[\s\S]*?\*\//)[0]);
            return 0;
        case 'concurrency':
            return concurrencyRun(opts);
        default:
            return liveRun(opts);
    }
}

let exitCode = 1;
try {
    exitCode = await main();
} catch (err) {
    console.error(err);
    exitCode = 1;
}
process.exit(exitCode);
