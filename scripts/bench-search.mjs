#!/usr/bin/env node
/* eslint-env node */
/**
 * Search benchmark: times `POST /api/characters/query` for every request shape the character list can send,
 * against the live library, read-only. Nothing is copied: not the library, the metadata db or the indexes.
 *
 * Each measurement is a fresh child process. It turns the server code's read-only mode on, opens the metadata store,
 * the search engine and both search index readers through the real server code, mounts the real characters router on
 * 127.0.0.1, then sends one shape's body once cold and 5 times warm and prints one JSON line. Every shape runs in 5
 * such processes, for each of WORDS when it has a search term.
 *
 * `--out` gets a `{"type":"header"}` line, one line per child, then a `{"type":"end"}` line once every child has run.
 *
 * `--concurrency` is a separate run that writes, on a made-up library in `--scratch` and never on live: see
 * concurrencyRun(). There `--user-dir` and `--config` are only read, by the generator, to shape the library, and
 * `--out` gets one JSON document.
 *
 * Usage:
 *   node scripts/bench-search.mjs [--user-dir <dir>] [--config <file>] [--out <raw.jsonl>] [--only <regex on shape id>]
 *   node scripts/bench-search.mjs --list [--user-dir <dir>]
 *   node scripts/bench-search.mjs --report <raw.jsonl>
 *   node scripts/bench-search.mjs --pick-words [--user-dir <dir>]
 *   node scripts/bench-search.mjs --concurrency --scratch <empty dir> [--keep] [--timeout-min <n>] [--user-dir <dir>]
 *                                 [--config <file>] [--out <raw.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');

const CANDIDATES = ['the', 'you', 'and', 'her', 'his', 'she', 'girl', 'woman', 'man', 'friend', 'school', 'love', 'dark', 'magic', 'king', 'queen', 'princess', 'knight', 'dragon', 'vampire', 'witch', 'demon', 'angel', 'elf', 'goblin', 'werewolf', 'zombie', 'ghost', 'pirate', 'ninja', 'samurai', 'detective', 'robot', 'android', 'cyberpunk', 'alien', 'assassin', 'soldier', 'teacher', 'nurse', 'maid', 'mermaid', 'fox', 'cat', 'wolf', 'sword', 'forest', 'ocean', 'space', 'medieval', 'library', 'coffee', 'bakery', 'lighthouse', 'volcano', 'submarine', 'astronaut', 'archaeologist', 'glacier', 'saxophone', 'origami', 'zeppelin', 'kaleidoscope', 'marionette', 'quokka'];

// Tiers by description docFreq from the pick-words run on 2026-09-26 (numDocs 379,408): high = girl/the/love,
// mid = dragon/vampire/detective, low = saxophone/quokka, 2-letter prefix = dr, two-word = dark knight.
/** @type {string[]} */
const WORDS = ['girl', 'the', 'love', 'dragon', 'vampire', 'detective', 'saxophone', 'quokka', 'dr', 'dark knight'];

const PICK_FIELDS = ['name', 'description', 'first_mes', 'personality', 'scenario', 'tags', 'resolved_tags', 'creator'];
const BOOT_LOG_MARKER = '[metadata-chain] reconcile';

/** Fresh processes per shape and word. */
const PROCESSES = 5;
/** Warm requests after the cold one, in the same process. */
const WARM_RUNS = 5;
const PAGE_SIZE = 50;
const DEEP_PAGE = 100;
const DROPDOWN_PAGE_SIZE = 500;
/** The random sort's seed, the same in every run so shapes line up across runs. */
const RANDOM_SEED = 1234567890;
/** A shape fails when its cold p50 or its warm max is over this many ms. */
const LIMIT_MS = 100;

/** Prefixes the child's one JSON result line on stdout; server code may print other lines there too. */
const CHILD_RESULT_MARKER = 'BENCH_CHILD_RESULT ';

const NOTE = 'Note: "Show only groups" and "Show only folders" send the same body as no filter, and opening a folder'
    + ' sends tags.include:[folderTagId], the same shape as 1 included tag, so neither is a shape of its own. The live'
    + ' library has no folder tags (as of 2026-09-28: none of its 68,821 tags has folder_type OPEN or CLOSED).';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
    const opts = {
        mode: 'run',
        child: null,
        report: null,
        out: null,
        only: null,
        userDir: path.join(REPO_ROOT, 'data', 'default-user'),
        config: path.join(REPO_ROOT, 'config.yaml'),
        scratch: null,
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
        given.add(a);
        switch (a) {
            case '--help': opts.mode = 'help'; break;
            case '--concurrency': opts.mode = 'concurrency'; break;
            case '--scratch': opts.scratch = path.resolve(next()); break;
            case '--keep': opts.keep = true; break;
            case '--timeout-min': {
                const v = Number(next());
                if (!Number.isInteger(v) || v <= 0) throw new Error('--timeout-min needs a positive whole number of minutes');
                opts.timeoutMin = v;
                break;
            }
            case '--list': opts.mode = 'list'; break;
            case '--pick-words': opts.mode = 'pick-words'; break;
            case '--report': opts.mode = 'report'; opts.report = path.resolve(next()); break;
            case '--child': opts.mode = 'child'; opts.child = JSON.parse(next()); break;
            case '--out': opts.out = path.resolve(next()); break;
            case '--only': opts.only = new RegExp(next()); break;
            case '--user-dir': opts.userDir = path.resolve(next()); break;
            case '--config': opts.config = path.resolve(next()); break;
            default: throw new Error(`unknown argument: ${a}`);
        }
    }
    const allowed = {
        'run': ['--user-dir', '--config', '--out', '--only'],
        'list': ['--list', '--user-dir'],
        'report': ['--report'],
        'pick-words': ['--pick-words', '--user-dir'],
        'child': ['--child'],
        'help': ['--help'],
        'concurrency': ['--concurrency', '--scratch', '--keep', '--timeout-min', '--user-dir', '--config', '--out'],
    }[opts.mode];
    const extra = [...given].filter(a => !allowed.includes(a));
    if (extra.length > 0) throw new Error(`${extra.join(', ')} can't be used with ${opts.mode === 'run' ? 'the live run' : `--${opts.mode}`}`);
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

function metadataDbPath(userDir) {
    return path.join(userDir, 'character-metadata.sqlite');
}

/**
 * Opens the user's metadata db read-only for `fn`, then closes it.
 * @template T
 * @param {string} userDir
 * @param {(db: any) => T} fn
 * @returns {Promise<T>}
 */
async function withReadOnlyDb(userDir, fn) {
    const Database = await loadDatabase();
    const db = new Database(metadataDbPath(userDir), { readonly: true, fileMustExist: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------- response decoding

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

/** The binary hash-mode response of /query (characters.js serializeQueryHashesBinary()). */
function decodeHashesBinary(buf) {
    let o = 0;
    const headerFlags = buf.readUInt8(o); o += 1;
    o += 1; // backend
    const seq = buf.readDoubleLE(o); o += 8;
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
    const hasTotal = (headerFlags & 0b01) !== 0;
    return { seq, total, hasTotal, approxTotal: hasTotal && (headerFlags & 0b10) !== 0, count, ids };
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
 * The three most-used tags by character count, with their names.
 * @param {string} userDir
 * @returns {Promise<{ id: string, name: string|null, count: number }[]>}
 */
async function readTopTags(userDir) {
    return withReadOnlyDb(userDir, db => {
        const top = [];
        const rows = db.prepare('SELECT tag_id, COUNT(*) AS c FROM character_tags GROUP BY tag_id ORDER BY c DESC, tag_id ASC LIMIT 3').iterate();
        for (const row of rows) top.push({ id: row.tag_id, name: null, count: row.c });
        if (top.length < 3) throw new Error(`the library has ${top.length} used tags; the tag shapes need 3`);
        const nameOf = db.prepare('SELECT data FROM tags WHERE id = ?');
        for (const tag of top) {
            const row = nameOf.get(tag.id);
            tag.name = row ? (JSON.parse(row.data).name ?? null) : null;
        }
        return top;
    });
}

/**
 * The search sort's order as the client sends it: "desc" when power_user.sort_order is "desc", else "asc".
 * @param {string} userDir
 * @returns {'asc'|'desc'}
 */
function readSearchOrder(userDir) {
    const file = path.join(userDir, 'settings', 'power_user.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).sort_order === 'desc' ? 'desc' : 'asc';
}

async function loadShapes(userDir) {
    const tags = await readTopTags(userDir);
    const shapes = buildShapes({ tagIds: tags.map(t => t.id), searchOrder: readSearchOrder(userDir) });
    return { tags, shapes };
}

function describeTags(tags) {
    return tags.map((t, i) => `t${i + 1} = ${t.id} (${t.name === null ? 'no definition' : JSON.stringify(t.name)}, ${t.count} characters)`).join('; ');
}

// ---------------------------------------------------------------- --list

async function listShapes(opts) {
    const { shapes } = await loadShapes(opts.userDir);
    console.log(`${shapes.length} shapes. A body with "<word>" runs once for each of: ${WORDS.join(', ')}.`);
    for (const shape of shapes) console.log(`${shape.id}  ${JSON.stringify(shape.body(shape.hasTerm ? '<word>' : null))}`);
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

// ---------------------------------------------------------------- child

/**
 * One timed POST /api/characters/query, end to end: from before the fetch to after the body is read.
 * @param {string} url
 * @param {string} bodyText
 */
async function timedQuery(url, bodyText) {
    const t0 = performance.now();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: bodyText });
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
    const decoded = decodeHashesBinary(Buffer.from(ab));
    record.total = decoded.hasTotal ? decoded.total : null;
    record.approxTotal = decoded.approxTotal;
    record.count = decoded.count;
    record.seq = decoded.seq;
    return record;
}

/**
 * Runs in a fresh process: opens everything through the real server code with read-only mode on, then sends
 * `spec.body` once cold and WARM_RUNS times warm, and prints one result line.
 * @param {{ configPath: string, userDir: string, body: object }} spec
 */
async function runChild(spec) {
    const src = rel => pathToFileURL(path.join(REPO_ROOT, 'src', rel)).href;

    // Several modules read config at import, so the config path is set before anything else is imported.
    const { setConfigFilePath } = await import(src('util.js'));
    setConfigFilePath(spec.configPath);
    globalThis.DATA_ROOT = path.dirname(spec.userDir);

    // The bench turns the server code's read-only mode on from code, before anything opens.
    const readOnlyMode = await import(src('read-only-mode.js'));
    readOnlyMode.enableReadOnlyMode();
    if (readOnlyMode.isReadOnlyMode() !== true) {
        throw new Error('read-only mode did not turn on; nothing was opened');
    }

    const handle = path.basename(spec.userDir);
    const { getUserDirectories } = await import(src('users.js'));
    const directories = getUserDirectories(handle);
    if (path.resolve(directories.root) !== path.resolve(spec.userDir)) {
        throw new Error(`getUserDirectories(${JSON.stringify(handle)}).root is ${directories.root}, not ${spec.userDir}`);
    }
    const { ensureSchemaMigrated } = await import(src('character-metadata-db.js'));
    const { resolveSearchEngine } = await import(src('endpoints/search-engine.js'));
    const { getSearchIndex } = await import(src('endpoints/search-index-coordinator.js'));
    const { router } = await import(src('endpoints/characters.js'));
    const express = (await import('express')).default;
    const bodyParser = (await import('body-parser')).default;

    await ensureSchemaMigrated(directories);
    const engine = await resolveSearchEngine();
    if (engine.tier !== 'tantivy') throw new Error(`search engine tier is ${engine.tier}`);
    for (const target of ['characters', 'groups']) {
        const reader = await getSearchIndex(handle, directories, target);
        if (!reader) throw new Error(`the ${target} search index did not open`);
    }

    const app = express();
    app.use(bodyParser.json({ limit: '500mb' }));
    app.use((request, _response, next) => {
        request.user = { profile: { handle }, directories };
        next();
    });
    app.use('/api/characters', router);
    const server = await new Promise((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
    });
    const { port } = /** @type {net.AddressInfo} */ (server.address());
    const openedAt = performance.timeOrigin + performance.now();

    const url = `http://127.0.0.1:${port}/api/characters/query`;
    const bodyText = JSON.stringify(spec.body);
    const requests = [];
    for (let i = 0; i < 1 + WARM_RUNS; i++) requests.push(await timedQuery(url, bodyText));

    fs.writeSync(1, `${CHILD_RESULT_MARKER}${JSON.stringify({ openedAt, requests })}\n`);
}

// ---------------------------------------------------------------- live run

function gitInfo() {
    const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
    const head = git('rev-parse', 'HEAD').trim();
    const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
    return { head, dirty };
}

/**
 * Spawns one child for (shape, word, proc) and waits for it.
 * @returns {object} the raw line
 */
function measure(opts, shape, word, proc) {
    const body = shape.body(word);
    const spec = { configPath: opts.config, userDir: opts.userDir, body };
    const spawnedAt = performance.timeOrigin + performance.now();
    const r = spawnSync(process.execPath, [SCRIPT_PATH, '--child', JSON.stringify(spec)], {
        cwd: REPO_ROOT,
        env: { ...process.env, SILLYTAVERN_PERFORMANCE_SEARCHTIMING: 'true' },
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    const wallMs = performance.timeOrigin + performance.now() - spawnedAt;
    const stdoutLines = (r.stdout ?? '').split('\n');
    const resultLines = stdoutLines.filter(l => l.startsWith(CHILD_RESULT_MARKER));
    const output = [...stdoutLines.filter(l => !l.startsWith(CHILD_RESULT_MARKER) && l !== ''), r.stderr ?? ''].join('\n').trim();
    const line = { shape: shape.id, word, proc, body, exitCode: r.status, signal: r.signal, wallMs, startupMs: null, requests: null, failure: null, output };
    if (r.error) {
        line.failure = `spawn failed: ${r.error.message}`;
    } else if (r.status !== 0 || resultLines.length !== 1) {
        line.failure = `exit code ${r.status}${r.signal ? `, signal ${r.signal}` : ''}, ${resultLines.length} result lines`;
    } else {
        const result = JSON.parse(resultLines[0].slice(CHILD_RESULT_MARKER.length));
        line.startupMs = result.openedAt - spawnedAt;
        line.requests = result.requests;
    }
    return line;
}

async function liveRun(opts) {
    if (opts.out && (isInside(opts.out, path.join(REPO_ROOT, 'data')) || isInside(opts.out, opts.userDir))) {
        throw new Error(`--out ${opts.out} is inside the data dir; the bench writes nothing there`);
    }
    if (opts.out && fs.existsSync(opts.out)) throw new Error(`--out ${opts.out} already exists`);
    const startedAt = new Date().toISOString();
    const git = gitInfo();
    const { tags, shapes: allShapes } = await loadShapes(opts.userDir);
    const shapes = opts.only ? allShapes.filter(s => opts.only.test(s.id)) : allShapes;
    if (shapes.length === 0) throw new Error(`--only ${opts.only} matches no shape id (see --list)`);
    const seqStart = await withReadOnlyDb(opts.userDir, db => maxSeq(db, 'changes'));
    const header = {
        type: 'header',
        time: startedAt,
        checkout: REPO_ROOT,
        head: git.head,
        dirty: git.dirty,
        tags,
        seed: RANDOM_SEED,
        words: WORDS,
        seqStart,
    };

    // Opened before the first child, so an existing file is refused before anything runs. The header line goes
    // first and the end line last, so `--report` can print the header and tell an interrupted run by its missing end.
    const outFd = opts.out ? fs.openSync(opts.out, 'wx') : null;

    const total = shapes.reduce((n, s) => n + (s.hasTerm ? WORDS.length : 1) * PROCESSES, 0);
    /** @type {object[]} */
    const lines = [];
    let end;
    try {
        if (outFd !== null) fs.writeSync(outFd, `${JSON.stringify(header)}\n`);
        for (const shape of shapes) {
            for (const word of shape.hasTerm ? WORDS : [null]) {
                for (let proc = 0; proc < PROCESSES; proc++) {
                    // A crashed child doesn't stop the run, so one crash can't cost a long run its remaining hours;
                    // printReport() lists it and marks its shape ERROR.
                    const line = measure(opts, shape, word, proc);
                    lines.push(line);
                    if (outFd !== null) fs.writeSync(outFd, `${JSON.stringify(line)}\n`);
                    console.error(`${new Date().toISOString()} [${lines.length}/${total}] ${shape.id} ${word ?? '-'} #${proc} exit=${line.exitCode} wall=${fmt(line.wallMs)}ms startup=${fmt(line.startupMs)}ms${line.failure ? ` CRASHED (${line.failure})` : ''}`);
                }
            }
        }
        const seqEnd = await withReadOnlyDb(opts.userDir, db => maxSeq(db, 'changes'));
        end = { type: 'end', seqEnd, time: new Date().toISOString() };
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
        console.log(`checkout: ${header.checkout} at ${header.head}, ${header.dirty.length === 0 ? 'clean' : `dirty (${header.dirty.length} files):`}`);
        for (const f of header.dirty) console.log(`  ${f}`);
        console.log(`tags: ${describeTags(header.tags)}`);
        console.log(`random seed: ${header.seed}`);
        console.log(`words: ${header.words.join(', ')}`);
    }
    const seqStart = header ? header.seqStart : 'not in the file';
    console.log(`changes MAX(seq): ${seqStart} at start, ${end ? end.seqEnd : 'not reached'} at end`);
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
 * Prints one row per shape from raw lines, pooling a shape's words, then every errored request and failed child.
 * @param {object[]} lines
 * @returns {boolean} whether every shape passed and nothing errored
 */
function printReport(lines) {
    /** @type {Map<string, { cold: object[], warm: object[], errors: string[] }>} */
    const byShape = new Map();
    for (const line of lines) {
        if (!byShape.has(line.shape)) byShape.set(line.shape, { cold: [], warm: [], errors: [] });
        const s = byShape.get(line.shape);
        const where = `${line.shape} ${line.word ?? '-'} #${line.proc}`;
        if (line.failure) {
            s.errors.push(`${where}: child failed (${line.failure})${line.output ? `:\n${line.output}` : ''}`);
            continue;
        }
        // Errored requests stay out of the timings: a fast 500 would pull the p50 down, a hung one the max up.
        line.requests.forEach((r, i) => {
            if (r.error) s.errors.push(`${where} ${i === 0 ? 'cold' : `warm ${i}`}: ${r.error}`);
            else (i === 0 ? s.cold : s.warm).push(r);
        });
    }

    const rows = [];
    const errors = [];
    let allPass = true;
    for (const [id, s] of byShape) {
        const coldE2e = s.cold.map(r => r.e2e);
        const warmE2e = s.warm.map(r => r.e2e);
        const coldP50 = median(coldE2e);
        const warmMax = warmE2e.length ? Math.max(...warmE2e) : null;
        const coldFail = coldP50 !== null && coldP50 > LIMIT_MS;
        const warmFail = warmMax !== null && warmMax > LIMIT_MS;
        const marks = [];
        if (coldFail || warmFail) marks.push('FAIL');
        if (s.errors.length > 0) marks.push('ERROR');
        if (marks.length > 0) allPass = false;
        const dominant = [];
        if (coldFail) dominant.push(`cold: ${dominantByMedian(s.cold)}`);
        if (warmFail) dominant.push(`warm: ${dominantOfMax(s.warm)}`);
        rows.push([
            id, `${s.cold.length}/${s.warm.length}`,
            fmt(coldP50), fmt(coldE2e.length ? Math.max(...coldE2e) : null),
            fmt(median(warmE2e)), fmt(warmMax),
            marks.length ? marks.join(' ') : 'PASS', dominant.join(', ') || '-',
        ]);
        errors.push(...s.errors);
    }
    printTable(['shape', 'n cold/warm', 'cold p50', 'cold max', 'warm p50', 'warm max', 'result', 'dominant phase'], rows);
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

// The concurrency run times queries while the search index worker catches up on a burst of change-log writes, to
// show requests don't wait on the catch-up. It writes, so it never runs on the live library: it runs on a made-up
// library that scripts/bench-search-synth.mjs generates in `--scratch`.
//
// Scratch layout: data/ (the data root, with the generated library in data/default-user), config.yaml (the default
// config, created by the server on first start), global-extensions/, server.log.

const state = {
    server: null,
    dbHandles: new Set(),
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

/** Stops the server, closes the bench's db handles, and clears the scratch dir unless `--keep`. */
async function cleanupConcurrency() {
    if (state.cleanedUp) return;
    state.cleanedUp = true;
    await stopServer();
    for (const db of state.dbHandles) {
        try { db.close(); } catch { /* already closed */ }
    }
    state.dbHandles.clear();
    if (state.scratch === null) return;
    if (state.keep) {
        console.log(`kept: ${state.scratch} (server log: ${path.join(state.scratch, 'server.log')})`);
    } else {
        clearScratch(state.scratch);
        console.log(`cleared: ${state.scratch}`);
    }
}

function percentile(values, p) {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * s.length);
    return s[Math.min(s.length, Math.max(1, rank)) - 1];
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
 * Checks `--scratch`: outside the live data root (the live user dir's parent, both by real path), and empty or
 * missing. Creates it when missing. Returns its real path.
 */
function checkScratchDir(opts) {
    const liveDataRoot = path.dirname(fs.realpathSync(opts.userDir));
    let scratch = path.resolve(opts.scratch);
    if (fs.existsSync(scratch)) scratch = fs.realpathSync(scratch);
    else scratch = path.join(fs.realpathSync(path.dirname(scratch)), path.basename(scratch));
    if (isInside(scratch, liveDataRoot)) throw new Error(`--scratch ${scratch} is inside the live data root ${liveDataRoot}`);
    if (isInside(liveDataRoot, scratch)) throw new Error(`--scratch ${scratch} contains the live data root ${liveDataRoot}`);
    if (!fs.existsSync(scratch)) fs.mkdirSync(scratch);
    if (fs.readdirSync(scratch).length > 0) throw new Error(`--scratch ${scratch} is not empty`);
    return scratch;
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
        for (;;) {
            if (state.server.exitCode !== null) throw new Error(`server exited with code ${state.server.exitCode}`);
            if (Date.now() > deadline) throw new Error(`timed out waiting for "${BOOT_LOG_MARKER}" in server.log`);
            if (fs.readFileSync(logPath, 'utf8').includes(BOOT_LOG_MARKER)) break;
            await sleep(1000);
        }
        console.log('server boot chain reached reconcile');
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

/**
 * The live library's default sort as the client sends it, from power_user.json's sort_field and sort_order.
 * @param {string} userDir
 */
function readDefaultSort(userDir) {
    const raw = JSON.parse(fs.readFileSync(path.join(userDir, 'settings', 'power_user.json'), 'utf8'));
    const sortField = raw.sort_field;
    const sortOrder = raw.sort_order;
    console.log(`live default sort: sort_field=${JSON.stringify(sortField)} sort_order=${JSON.stringify(sortOrder)}`);
    if (sortOrder === 'random') throw new Error('random default sort not supported by the concurrency run');
    return { field: sortField, order: sortOrder === 'desc' ? 'desc' : 'asc' };
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

/**
 * Resolves (with performance.now()) once the index watermarks cover `targets`, or the current log maxima when
 * no targets are given.
 */
async function waitCaughtUp({ dbPath, deadline, targets }) {
    const Database = await loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    state.dbHandles.add(db);
    try {
        for (;;) {
            if (Date.now() > deadline) throw new Error('timed out waiting for the catch-up');
            const changesMax = targets?.changesMax ?? maxSeq(db, 'changes');
            const tagMax = targets?.tagMax ?? maxSeq(db, 'tag_name_changes');
            const idxSeq = Number(metaValue(db, 'tantivy_char_index_seq') ?? -1);
            const tagSeq = Number(metaValue(db, 'tantivy_char_index_tag_name_change_seq') ?? -1);
            if (idxSeq >= changesMax && tagSeq >= tagMax) return performance.now();
            await sleep(1000);
        }
    } finally {
        db.close();
        state.dbHandles.delete(db);
    }
}

/**
 * Writes the burst (5,000 upserts + 20 deletes, the deletes from the first word's first page) to the scratch db, then
 * times queries back to back, cycling the words, until the deletes are out of the index and the catch-up is done.
 */
async function runConcurrency({ session, dbPath, indexDir, primary, deadline, run }) {
    const Database = await loadDatabase();
    const tantivy = await loadTantivy();
    const records = run.records;

    const probe = await query(session, WORDS[0], primary);
    if (probe.error) throw new Error(`concurrency probe query failed: ${probe.error}`);
    const deleteIds = probe.ids.filter(r => !r.isGroup).slice(0, 20).map(r => r.id);

    const db = new Database(dbPath, { fileMustExist: true });
    state.dbHandles.add(db);
    let T0;
    let targets;
    const result = { deleteIds: deleteIds.length, upserts: 0, deleteVisibleMs: null, catchUpDoneMs: null };
    run.concurrency = result;
    try {
        db.pragma('busy_timeout = 10000');
        const placeholders = deleteIds.map(() => '?').join(', ');
        const upsertIds = [];
        for (const row of db.prepare(`SELECT id FROM characters WHERE id NOT IN (${placeholders}) LIMIT 5000`).iterate(...deleteIds)) {
            upsertIds.push(row.id);
        }
        result.upserts = upsertIds.length;
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
    console.log(`concurrency burst: ${result.upserts} upserts + ${deleteIds.length} deletes committed`);

    if (deleteIds.length === 0) result.deleteVisibleMs = 0;
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
                result.deleteVisibleMs = performance.now() - T0;
                break;
            }
            await sleep(100);
        }
    })();

    const catchUpLoop = (async () => {
        const doneAt = await waitCaughtUp({ dbPath, deadline, targets });
        result.catchUpDoneMs = doneAt - T0;
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
}

/**
 * Prints the concurrency run's result from whatever `run` holds, so an errored run still reports what it got.
 * @returns {boolean} whether the max during catch-up is within LIMIT_MS and no request errored
 */
function reportConcurrency(run) {
    const g = run.generator;
    if (g) {
        console.log(`made-up library: ${g.cards} characters, ${g.groups} groups, ${g.tags} tags, index numDocs ${g.indexNumDocs}, seed ${g.params?.seed}`);
        if (g.shortfalls?.length > 0) {
            console.log(`words placed short of their live share (${g.shortfalls.length}):`);
            for (const s of g.shortfalls) console.log(`  ${s.term} in ${s.field}: target ${s.target}, ${s.eligible} cards can take it, ${s.short} short`);
        }
        if (g.mismatches?.length > 0) {
            console.log(`words whose index count differs from what was placed (${g.mismatches.length}):`);
            for (const m of g.mismatches) console.log(`  ${m.term} in ${m.field}: placed ${m.placed}, index has ${m.reached}`);
        }
    }
    console.log(`sort: ${JSON.stringify(run.sort)}, ${PAGE_SIZE} a page, words: ${WORDS.join(', ')}`);
    console.log(`wait for the server's index to be caught up before the burst: ${fmt(run.initialCatchUpMs)} ms`);

    const errors = run.records.filter(r => r.error);
    const during = run.records.filter(r => r.phase === 'concurrency' && !r.error).map(r => r.e2e);
    const max = during.length ? Math.max(...during) : null;
    const c = run.concurrency;
    if (c) {
        console.log(`burst: ${c.upserts} upserts + ${c.deleteIds} deletes`);
        console.log(`queries during catch-up: ${during.length}, median ${fmt(median(during))} ms, p95 ${fmt(percentile(during, 95))} ms, max ${fmt(max)} ms`);
        console.log(`deletes visible after ${fmt(c.deleteVisibleMs)} ms, catch-up done after ${fmt(c.catchUpDoneMs)} ms`);
    } else {
        console.log('burst: not reached');
    }
    for (const r of errors) console.log(`error: ${r.phase}/${r.word}: ${r.error}`);

    const marks = [];
    if (max !== null && max > LIMIT_MS) marks.push(`FAIL (max ${fmt(max)} ms > ${LIMIT_MS} ms)`);
    if (errors.length > 0) marks.push(`ERROR (${errors.length} requests)`);
    const done = c && c.deleteVisibleMs !== null && c.catchUpDoneMs !== null;
    if (!done) marks.push('INCOMPLETE');
    console.log(marks.length ? marks.join(' ') : 'PASS');
    return marks.length === 0;
}

async function concurrencyRun(opts) {
    if (opts.out && (isInside(opts.out, path.join(REPO_ROOT, 'data')) || isInside(opts.out, path.dirname(opts.userDir)))) {
        throw new Error(`--out ${opts.out} is inside a data dir; the bench writes nothing there`);
    }
    if (opts.out && isInside(opts.out, opts.scratch)) throw new Error(`--out ${opts.out} is inside --scratch, which is cleared`);
    if (opts.out && fs.existsSync(opts.out)) throw new Error(`--out ${opts.out} already exists`);
    if (!fs.existsSync(opts.config)) throw new Error(`--config ${opts.config} does not exist`);
    const sort = readDefaultSort(opts.userDir);
    opts.scratch = checkScratchDir(opts);
    state.scratch = opts.scratch;
    state.keep = opts.keep;
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            cleanupConcurrency().finally(() => process.exit(1));
        });
    }

    const git = gitInfo();
    const run = {
        type: 'concurrency',
        time: new Date().toISOString(),
        checkout: REPO_ROOT,
        head: git.head,
        dirty: git.dirty,
        words: WORDS,
        sort,
        pageSize: PAGE_SIZE,
        generator: null,
        initialCatchUpMs: null,
        concurrency: null,
        /** @type {object[]} */
        records: [],
    };
    const outFd = opts.out ? fs.openSync(opts.out, 'wx') : null;
    let pass = false;
    try {
        try {
            const { generateSynthLibrary, DEFAULT_CARD_COUNT, DEFAULT_SEED } = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts', 'bench-search-synth.mjs')).href);
            const dataRoot = path.join(opts.scratch, 'data');
            run.generator = await generateSynthLibrary(opts.userDir, dataRoot, WORDS, DEFAULT_CARD_COUNT, DEFAULT_SEED, { configPath: opts.config });
            const userDir = path.join(dataRoot, 'default-user');
            const dbPath = metadataDbPath(userDir);
            const indexDir = path.join(userDir, 'search-index', 'characters-tantivy');
            const primary = { name: 'primary', sort, pageSize: PAGE_SIZE };

            const { base } = await startServer(opts);
            const session = await openSession(base);
            const deadlineFrom = () => Date.now() + opts.timeoutMin * 60_000;
            const bootAt = performance.now();
            run.initialCatchUpMs = (await waitCaughtUp({ dbPath, deadline: deadlineFrom() })) - bootAt;
            await runConcurrency({ session, dbPath, indexDir, primary, deadline: deadlineFrom(), run });
        } catch (err) {
            console.error(err);
            run.error = err?.stack ?? String(err);
        }
        console.log('');
        pass = reportConcurrency(run) && !run.error;
        if (outFd !== null) {
            fs.writeSync(outFd, JSON.stringify({ ...run, records: run.records.map(r => ({ ...r, ids: undefined })) }, null, 2));
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
        case 'child':
            await runChild(opts.child);
            return 0;
        case 'list':
            await listShapes(opts);
            return 0;
        case 'report':
            return reportFromFile(opts.report);
        case 'pick-words':
            await pickWords(path.join(opts.userDir, 'search-index', 'characters-tantivy'));
            return 0;
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
