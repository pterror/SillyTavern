#!/usr/bin/env node
/* eslint-env node */
/**
 * Made-up character library for the search bench's concurrency run: `cardCount` characters shaped like the live
 * library, with the bench's words mixed in at their live share per indexed field, every boot flag and one-time
 * pass marker set as done (as live has them), and the character index built and caught up.
 *
 * Live is only ever read, through raw read-only handles, at run time: better-sqlite3 `{ readonly: true,
 * fileMustExist: true }` on `<live user dir>/character-metadata.sqlite` (every statement a point lookup or with a
 * LIMIT) and tantivy `Index.open()` on `<live user dir>/search-index/characters-tantivy` (searched, never written).
 * Nothing from live is written anywhere except as sizes, flags, counts and dates in the made-up library. Server
 * functions only ever get the scratch directories.
 *
 * The library is written through the repo's own write functions, in a child process of its own, which sets
 * DATA_ROOT, the config path and a settable clock. No PNG files are written: `last_reconcile_dir_mtime_ms` is set
 * so reconcile leaves the rows alone. Deterministic for a given seed and live library state.
 *
 * Usage:
 *   node scripts/bench-search-synth.mjs --user-dir <live user dir> --scratch <data root> [--config <file>]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import sanitize from 'sanitize-filename';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const HANDLE = 'default-user';

/** The bench's words. A string with a space is its words, each on its own. */
export const DEFAULT_WORDS = ['girl', 'the', 'love', 'dragon', 'vampire', 'detective', 'saxophone', 'quokka', 'dr', 'dark knight'];
export const DEFAULT_CARD_COUNT = 20000;
export const DEFAULT_SEED = 20260926;

// Must match BM25_INDEXED_COLUMNS in src/endpoints/characters-search-index.js, which doesn't export it.
const INDEXED_FIELDS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const TEXT_FIELDS = ['description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes'];

const LIVE_CHARACTER_SAMPLES = 300;
const LIVE_TAG_NAME_SAMPLES = 60;
const LIVE_TAG_COUNT_LIMIT = 200000;
const LIVE_GROUP_LIMIT = 10000;
const LIVE_TAGS_PER_ENTITY_LIMIT = 1000;

const VOCAB_SIZE = 30000;
const WORD_ZIPF_S = 1.0;
const TAG_ZIPF_S = 1.1;
// Below BATCH_IMPORT_FLUSH_SIZE (500), so a chunk's tag assignment lands on still-pending rows.
const IMPORT_CHUNK = 400;
// "now" for everything written after the cards (groups, meta flags): the live boot's flag timestamps' era.
const NOW_BASE = 1790428000000;
// Spec markers kept as flags; any other value is replaced (see sampleLive()).
const KNOWN_SPECS = new Set(['chara_card_v2', 'chara_card_v3']);
const KNOWN_SPEC_VERSIONS = new Set(['2.0', '3.0']);
// Extension keys buildExtensions() builds by name; any other key gets a made-up name of the same length.
const KNOWN_EXT_KEYS = new Set(['chub', 'depth_prompt', 'fav', 'talkativeness', 'world']);

// ---------------------------------------------------------------- shared helpers

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real path of `p`, or of its nearest existing ancestor joined with the rest. */
function realPathLoose(p) {
    const abs = path.resolve(p);
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
    return path.join(realPathLoose(path.dirname(abs)), path.basename(abs));
}

/**
 * The search terms: each word string split on whitespace, lowercased as the index's default tokenizer does, and
 * de-duplicated. A term the tokenizer would split or drop is refused.
 * @param {string[]} words
 * @returns {string[]}
 */
export function wordsToTerms(words) {
    const terms = [];
    for (const word of words) {
        for (const part of String(word).split(/\s+/).filter(Boolean)) {
            const term = part.toLowerCase();
            if (!/^[\p{L}\p{N}]+$/u.test(term) || Buffer.byteLength(term) > 40) {
                throw new Error(`"${part}" is not a single token of the index's default tokenizer`);
            }
            if (!terms.includes(term)) terms.push(term);
        }
    }
    if (terms.length === 0) throw new Error('no words given');
    return terms;
}

/**
 * An old-style card id, named as upstream's getPngName names a card file: the first of `<name>.png`,
 * `<name>1.png`, `<name>2.png`, ... not in `usedIds`.
 * @param {string} name
 * @param {Set<string>} usedIds
 * @returns {string}
 */
export function oldStyleCardId(name, usedIds) {
    const base = sanitize(name);
    let id = `${base}.png`;
    for (let n = 1; usedIds.has(id); n++) id = `${base}${n}.png`;
    return id;
}

function checkScratch(liveUserDir, scratchRoot) {
    const liveDataRoot = path.dirname(fs.realpathSync(liveUserDir));
    const scratch = realPathLoose(scratchRoot);
    if (isInside(scratch, liveDataRoot)) throw new Error(`scratch ${scratch} is inside the live data root ${liveDataRoot}`);
    if (!fs.existsSync(scratch)) fs.mkdirSync(scratch);
    if (fs.readdirSync(scratch).length > 0) throw new Error(`scratch ${scratch} is not empty`);
    return scratch;
}

// ---------------------------------------------------------------- api

/**
 * Builds the made-up library in `<scratchRoot>/default-user/...`, in a child process, and returns its report.
 * @param {string} liveUserDir The live user dir, read only through raw read-only handles
 * @param {string} scratchRoot The scratch data root; must be empty (or missing) and outside the live data root
 * @param {string[]} words Search words; a string with a space is its words, each on its own
 * @param {number} cardCount
 * @param {number} seed
 * @param {{ configPath?: string }} [options] configPath: default `<repo>/config.yaml`
 * @returns {Promise<object>} The report
 */
export async function generateSynthLibrary(liveUserDir, scratchRoot, words, cardCount, seed, { configPath } = {}) {
    if (!Number.isInteger(cardCount) || cardCount <= 0) throw new Error('cardCount must be a positive integer');
    if (!Number.isInteger(seed)) throw new Error('seed must be an integer');
    const terms = wordsToTerms(words);
    const live = fs.realpathSync(liveUserDir);
    const scratch = checkScratch(live, scratchRoot);
    const config = path.resolve(configPath ?? path.join(REPO_ROOT, 'config.yaml'));
    if (!fs.existsSync(config)) throw new Error(`config file ${config} does not exist`);

    const child = fork(SCRIPT_PATH, ['--child'], { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    /** @type {object | null} */
    let report = null;
    /** @type {string | null} */
    let childError = null;
    child.on('message', (msg) => {
        if (msg?.type === 'report') report = msg.report;
        if (msg?.type === 'error') childError = msg.error;
    });
    const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.send({ liveUserDir: live, scratchRoot: scratch, words, terms, cardCount, seed, configPath: config });
    const { code, signal } = await exited;
    if (childError) throw new Error(`generator failed: ${childError}`);
    if (code !== 0 || !report) throw new Error(`generator exited with ${signal ?? `code ${code}`} and no report`);
    return report;
}

// ---------------------------------------------------------------- child: live reads

/**
 * Bounded read-only sample of the live metadata db: per-card sizes, flags, counts and dates, tag name lengths,
 * the tag count, and the groups' fav flags and tag counts.
 */
function sampleLive(Database, liveUserDir) {
    const db = new Database(path.join(liveUserDir, 'character-metadata.sqlite'), { readonly: true, fileMustExist: true });
    try {
        const maxRowid = db.prepare('SELECT MAX(rowid) AS m FROM characters').get().m;
        if (!maxRowid) throw new Error('the live characters table is empty');
        const pick = db.prepare('SELECT rowid AS rid, * FROM characters WHERE rowid >= ? ORDER BY rowid LIMIT 1');
        const tagCountOf = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM character_tags WHERE character_id = ? LIMIT ${LIVE_TAGS_PER_ENTITY_LIMIT})`);
        const samples = [];
        let replacedSpecs = 0;
        let replacedExtKeys = 0;
        for (let k = 0; k < LIVE_CHARACTER_SAMPLES; k++) {
            const r = pick.get(Math.floor(1 + (maxRowid - 1) * k / LIVE_CHARACTER_SAMPLES));
            if (!r) continue;
            const card = JSON.parse(r.card_json);
            const d = card.data ?? {};
            const dataLens = {};
            for (const [key, v] of Object.entries(d)) dataLens[key] = typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length;
            const cardTop = {};
            for (const key of Object.keys(card)) cardTop[key] = true;
            const extKeys = Object.keys(d.extensions ?? {}).map((key) => {
                if (KNOWN_EXT_KEYS.has(key)) return { known: key };
                replacedExtKeys++;
                return { length: key.length };
            });
            let spec = card.spec;
            let specVersion = card.spec_version;
            if (spec !== undefined && !KNOWN_SPECS.has(spec)) { spec = 'chara_card_v2'; replacedSpecs++; }
            if (specVersion !== undefined && !KNOWN_SPEC_VERSIONS.has(specVersion)) { specVersion = '2.0'; replacedSpecs++; }
            const cardFav = card.fav === undefined || typeof card.fav === 'boolean' || card.fav === 'true' || card.fav === 'false' ? card.fav : !!card.fav;
            samples.push({
                idLen: r.id.length,
                fav: r.fav,
                date_added: r.date_added,
                create_date: r.create_date,
                worldSet: r.world !== null,
                versionLen: typeof r.version === 'string' ? r.version.length : null,
                activeChatSet: r.active_chat !== null,
                contentHashSet: r.content_hash !== null,
                cardTop,
                spec,
                specVersion,
                dataLens,
                extKeys,
                altGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.length : null,
                bookEntries: d.character_book?.entries?.length ?? null,
                cardFav,
                tagCount: tagCountOf.get(r.id).n,
            });
        }

        const tagMax = db.prepare('SELECT MAX(rowid) AS m FROM tags').get().m ?? 0;
        const tagPick = db.prepare('SELECT data FROM tags WHERE rowid >= ? ORDER BY rowid LIMIT 1');
        const tagNameLens = [];
        for (let k = 0; k < LIVE_TAG_NAME_SAMPLES && tagMax > 0; k++) {
            const t = tagPick.get(Math.floor(1 + (tagMax - 1) * k / LIVE_TAG_NAME_SAMPLES));
            if (!t) continue;
            try {
                tagNameLens.push(String(JSON.parse(t.data).name ?? '').length);
            } catch { /* an unparseable tag row has no name length */ }
        }
        if (tagNameLens.length === 0) tagNameLens.push(8);

        const tagCount = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM tags LIMIT ${LIVE_TAG_COUNT_LIMIT})`).get().n;
        const groups = [];
        for (const g of db.prepare(`SELECT g.fav AS fav, (SELECT COUNT(*) FROM (SELECT 1 FROM group_tags gt WHERE gt.group_id = g.id LIMIT ${LIVE_TAGS_PER_ENTITY_LIMIT})) AS ntags FROM groups g ORDER BY g.rowid LIMIT ${LIVE_GROUP_LIMIT}`).iterate()) {
            groups.push({ fav: !!g.fav, ntags: g.ntags });
        }
        return {
            samples, tagNameLens, tagCount, groups, replacedSpecs, replacedExtKeys,
            tagCountCapped: tagCount >= LIVE_TAG_COUNT_LIMIT,
            groupsCapped: groups.length >= LIVE_GROUP_LIMIT,
        };
    } finally {
        db.close();
    }
}

/** Docs matching `term` exactly in `field` (deleted docs excluded), and numDocs, per the index at `indexDir`. */
function termCounter(tantivy, indexDir) {
    const index = tantivy.Index.open(indexDir);
    const searcher = index.searcher();
    const schema = index.schema;
    return {
        numDocs: searcher.numDocs,
        count(field, term) {
            return searcher.search(tantivy.Query.termQuery(schema, field, term), 1, true).count ?? 0;
        },
    };
}

// ---------------------------------------------------------------- child: generator

async function runChild(args) {
    const { liveUserDir, scratchRoot, terms, cardCount, seed, configPath } = args;
    const t0 = performance.now();
    const log = (msg) => console.log(`[synth +${((performance.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
    const timings = {};
    const mark = (name) => { timings[name] = Math.round(performance.now() - t0); };

    const { default: Database } = await import('better-sqlite3');
    const tantivyImport = await import('@oxdev03/node-tantivy-binding');
    const tantivy = tantivyImport.default ?? tantivyImport;

    // ---- live, read only ----
    const live = sampleLive(Database, liveUserDir);
    const liveIndex = termCounter(tantivy, path.join(liveUserDir, 'search-index', 'characters-tantivy'));
    const liveNumDocs = liveIndex.numDocs;
    if (!(liveNumDocs > 0)) throw new Error(`live index numDocs = ${liveNumDocs}`);
    /** @type {{ term: string, field: string, liveDocs: number, liveShare: number, target: number }[]} */
    const wordPlan = [];
    for (const term of terms) {
        for (const field of INDEXED_FIELDS) {
            const liveDocs = liveIndex.count(field, term);
            const liveShare = liveDocs / liveNumDocs;
            wordPlan.push({ term, field, liveDocs, liveShare, target: Math.round(liveShare * cardCount) });
        }
    }
    mark('liveReadMs');
    log(`live read: ${live.samples.length} character samples, ${live.tagCount} tags, ${live.groups.length} groups, numDocs ${liveNumDocs}`);
    if (live.tagCount < terms.length) throw new Error(`the live library has ${live.tagCount} tags, fewer than the ${terms.length} word tags`);

    // ---- process setup: scratch data root, config path, clock ----
    globalThis.DATA_ROOT = scratchRoot;
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(configPath);
    const { USER_DIRECTORY_TEMPLATE } = await import('../src/constants.js');
    const directories = Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([k, v]) => [k, path.join(scratchRoot, HANDLE, v)]));

    // ---- deterministic randomness and clock ----
    function mulberry32(a) {
        return () => {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    const rand = mulberry32(seed);
    const randInt = (n) => Math.floor(rand() * n);
    const pickOne = (arr) => arr[randInt(arr.length)];
    const hex = (bytes) => Array.from({ length: bytes }, () => randInt(256).toString(16).padStart(2, '0')).join('');

    // The repo stamps date_added and meta flag values with Date.now(); a settable clock keeps them deterministic.
    let clock = NOW_BASE;
    Date.now = () => clock++;

    function uuidV4() {
        const h = hex(16).split('');
        h[12] = '4';
        h[16] = '89ab'[randInt(4)];
        const s = h.join('');
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
    }
    function uuidV7(ms) {
        const ts = ms.toString(16).padStart(12, '0');
        const r = hex(10).split('');
        r[0] = '7';
        r[4] = '89ab'[randInt(4)];
        const s = ts + r.join('');
        return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
    }

    // ---- text ----
    const SYLLABLES = ['ka', 'ri', 'to', 'na', 'me', 'lo', 'sa', 'vi', 'en', 'dor', 'th', 'ar', 'is', 'mo', 'lu', 'qu', 'ze', 'pha', 'gr', 'el', 'ion', 'st', 'ba', 'cy', 'ou', 'wy', 'nd', 'fe', 'hi', 'jo'];
    function makeWord(minSyl, maxSyl) {
        let w = '';
        const n = minSyl + randInt(maxSyl - minSyl + 1);
        for (let i = 0; i < n; i++) w += pickOne(SYLLABLES);
        return w;
    }
    // No vocabulary word starts with a term: text() cuts its last word short, which would leave the term behind.
    const vocab = [];
    {
        const seen = new Set();
        while (vocab.length < VOCAB_SIZE) {
            const w = makeWord(1, 4);
            if (!seen.has(w) && !terms.some(t => w.startsWith(t))) { seen.add(w); vocab.push(w); }
        }
    }
    function zipfCdf(n, s) {
        const cdf = new Float64Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) { sum += 1 / Math.pow(i + 1, s); cdf[i] = sum; }
        for (let i = 0; i < n; i++) cdf[i] /= sum;
        return cdf;
    }
    function zipfDraw(cdf) {
        const u = rand();
        let lo = 0, hi = cdf.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < u) lo = mid + 1; else hi = mid; }
        return lo;
    }
    const wordCdf = zipfCdf(VOCAB_SIZE, WORD_ZIPF_S);
    function text(len) {
        if (len <= 0) return '';
        const parts = [];
        let n = 0, sentence = 0;
        while (n < len) {
            let w = vocab[zipfDraw(wordCdf)];
            if (sentence === 0) w = w[0].toUpperCase() + w.slice(1);
            const r = rand();
            if (r < 0.02) w = '{{char}}'; else if (r < 0.03) w = '{{user}}';
            sentence++;
            if (sentence > 8 + randInt(10)) { w += '.'; sentence = 0; }
            parts.push(w);
            n += w.length + 1;
        }
        return parts.join(' ').slice(0, len);
    }
    const capitalized = (len) => { const t = text(Math.max(len, 1)).replace(/[^a-z ]/gi, 'a'); return (t[0].toUpperCase() + t.slice(1)).slice(0, len); };
    const madeUpVersion = (len) => Array.from({ length: len }, (_, i) => (i % 2 ? '.' : String(randInt(10)))).join('');
    // The word as a token of its own, at a seeded word boundary.
    function insertToken(str, term) {
        const tokens = str.split(' ');
        tokens.splice(randInt(tokens.length + 1), 0, term);
        return tokens.join(' ');
    }

    function humanizedDate(ms) {
        const d = new Date(ms);
        const p = (v, n = 2) => String(v).padStart(n, '0');
        return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()} @${p(d.getUTCHours())}h ${p(d.getUTCMinutes())}m ${p(d.getUTCSeconds())}s ${p(d.getUTCMilliseconds(), 3)}ms`;
    }

    const db = await import('../src/character-metadata-db.js');
    const { checkForNewContent } = await import('../src/endpoints/content-manager.js');
    const { writeGroupFile } = await import('../src/endpoints/groups.js');
    const { getTantivyModule } = await import('../src/endpoints/tantivy-engine.js');
    const { createCharacterIndexMaintainer } = await import('../src/endpoints/characters-search-index.js');

    // ---- default content: already seeded, as on live. Character items are listed as seeded without being copied,
    // since the library's characters are the made-up ones; everything else is seeded by the repo's own code. ----
    fs.mkdirSync(directories.root, { recursive: true });
    {
        const contentIndex = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'default/content/index.json'), 'utf8'));
        const characterItems = contentIndex.filter(item => item.type === 'character').map(item => item.filename);
        fs.writeFileSync(path.join(directories.root, 'content.log'), characterItems.join('\n'));
    }
    await checkForNewContent([directories]);
    log('default content seeded');

    await db.ensureSchemaMigrated(directories);

    // ---- which cards get which word in which field ----
    const cardSamples = Array.from({ length: cardCount }, () => live.samples[randInt(live.samples.length)]);
    const eligible = (sample, field) => {
        switch (field) {
            case 'name': case 'creator': case 'tags': case 'resolved_tags': return true;
            case 'alternate_greetings': return (sample.altGreetings ?? 0) > 0;
            default: return (sample.dataLens[field] ?? 0) > 0;
        }
    };
    /** @type {Map<number, { field: string, term: string }[]>} */
    const insertsByCard = new Map();
    for (const entry of wordPlan) {
        const pool = [];
        for (let i = 0; i < cardCount; i++) if (eligible(cardSamples[i], entry.field)) pool.push(i);
        entry.eligible = pool.length;
        const take = Math.min(entry.target, pool.length);
        for (let k = 0; k < take; k++) {
            const j = k + randInt(pool.length - k);
            [pool[k], pool[j]] = [pool[j], pool[k]];
            const list = insertsByCard.get(pool[k]) ?? [];
            list.push({ field: entry.field, term: entry.term });
            insertsByCard.set(pool[k], list);
        }
        entry.placed = take;
    }

    // ---- tags: the live count, the word tags among them; the rest drawn Zipf, never a word tag ----
    const tags = [];
    const names = new Set(terms);
    const zipfTagCount = live.tagCount - terms.length;
    for (let i = 0; i < zipfTagCount; i++) {
        const len = Math.max(2, pickOne(live.tagNameLens));
        let name = text(len).replace(/[.{}]/g, '').trim() || makeWord(1, 2);
        while (names.has(name)) name = `${name} ${makeWord(1, 1)}`;
        names.add(name);
        tags.push({ id: uuidV4(), name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: null, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1743000000000 + randInt(47000000000) });
    }
    /** @type {Map<string, string>} term -> tag id */
    const wordTagIds = new Map();
    const wordTags = terms.map((term) => {
        const tag = { id: uuidV4(), name: term, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: null, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1743000000000 + randInt(47000000000) };
        wordTagIds.set(term, tag.id);
        return tag;
    });
    await db.saveTagDefinitions(directories, [...tags, ...wordTags]);
    log(`${tags.length + wordTags.length} tag definitions (${wordTags.length} word tags)`);
    const tagCdf = zipfCdf(tags.length, TAG_ZIPF_S);
    function drawTags(k) {
        const chosen = new Set();
        while (chosen.size < Math.min(k, tags.length)) chosen.add(zipfDraw(tagCdf));
        return [...chosen].map(i => tags[i]);
    }

    // ---- cards ----
    function buildExtensions(sample) {
        const ext = {};
        for (const k of sample.extKeys) {
            if (k.known === undefined) {
                let key;
                do key = makeWord(1, 4).padEnd(k.length, 'x').slice(0, k.length); while (key in ext || KNOWN_EXT_KEYS.has(key));
                ext[key] = {};
                continue;
            }
            switch (k.known) {
                case 'chub': ext.chub = { expressions: null, alt_expressions: {}, id: 100000 + randInt(9000000), full_path: `${makeWord(2, 3)}/${makeWord(2, 4)}-${hex(4)}`, related_lorebooks: [], background_image: null, preset: null, extensions: [] }; break;
                case 'depth_prompt': ext.depth_prompt = { prompt: '', depth: 4, role: 'system' }; break;
                case 'fav': ext.fav = !!sample.fav; break;
                case 'talkativeness': ext.talkativeness = '0.5'; break;
                case 'world': ext.world = sample.worldSet ? makeWord(2, 3) : ''; break;
            }
        }
        const target = sample.dataLens.extensions ?? 0;
        const short = target - JSON.stringify(ext).length;
        if (short > 0) {
            if (ext.depth_prompt) ext.depth_prompt.prompt = text(short);
            else ext.chub = { ...(ext.chub ?? {}), description: text(short) };
        }
        return ext;
    }
    function splitText(total, count) {
        if (count <= 0) return [];
        const each = Math.max(1, Math.floor(total / count) - 4);
        return Array.from({ length: count }, () => text(each));
    }
    function buildBook(sample) {
        const len = sample.dataLens.character_book;
        if (len === undefined) return undefined;
        const n = sample.bookEntries ?? 0;
        if (n === 0) return len <= 4 ? null : { name: '', entries: [], extensions: {} };
        const per = Math.max(20, Math.floor(len / n) - 260);
        return {
            name: makeWord(2, 4), description: '', scan_depth: 2, token_budget: 512, recursive_scanning: false, extensions: {},
            entries: Array.from({ length: n }, (_, i) => ({
                id: i, keys: [vocab[zipfDraw(wordCdf)], vocab[zipfDraw(wordCdf)]], secondary_keys: [], comment: makeWord(2, 3),
                content: text(per), constant: false, selective: true, insertion_order: 100, enabled: true, position: 'before_char',
                use_regex: true, extensions: { position: 0, exclude_recursion: false, display_index: i, probability: 100, useProbability: true, depth: 4 },
            })),
        };
    }

    const usedIds = new Set();
    const cardPlan = [];
    for (let i = 0; i < cardCount; i++) {
        const sample = cardSamples[i];
        const inserts = insertsByCard.get(i) ?? [];
        const dateAdded = sample.date_added + randInt(86400000);
        let name = capitalized(Math.max(2, sample.dataLens.name ?? 8));
        for (const { field, term } of inserts) if (field === 'name') name = insertToken(name, term);
        let id;
        if (sample.idLen === 40) {
            do {
                id = `${uuidV7(dateAdded)}.png`;
            } while (usedIds.has(id));
        } else {
            id = oldStyleCardId(name, usedIds);
        }
        usedIds.add(id);
        const cardTags = drawTags(sample.tagCount);
        const tagIds = cardTags.map(t => t.id);
        const L = sample.dataLens;
        const createDate = humanizedDate(sample.create_date ?? dateAdded);
        const data = {
            name,
            description: text(L.description ?? 0),
            personality: text(L.personality ?? 0),
            scenario: text(L.scenario ?? 0),
            first_mes: text(L.first_mes ?? 0),
            mes_example: text(L.mes_example ?? 0),
            creator_notes: text(L.creator_notes ?? 0),
            system_prompt: text(L.system_prompt ?? 0),
            post_history_instructions: text(L.post_history_instructions ?? 0),
            alternate_greetings: splitText(L.alternate_greetings ?? 0, sample.altGreetings ?? 0),
            tags: cardTags.map(t => t.name),
            creator: capitalized(Math.max(1, L.creator ?? 8)),
            character_version: sample.versionLen === null ? '' : madeUpVersion(sample.versionLen),
            extensions: buildExtensions(sample),
        };
        for (const { field, term } of inserts) {
            if (field === 'name') continue;
            if (TEXT_FIELDS.includes(field) || field === 'creator') data[field] = insertToken(data[field], term);
            else if (field === 'alternate_greetings') {
                const g = randInt(data.alternate_greetings.length);
                data.alternate_greetings[g] = insertToken(data.alternate_greetings[g], term);
            } else if (field === 'tags') data.tags.push(term);
            else if (field === 'resolved_tags') tagIds.push(/** @type {string} */ (wordTagIds.get(term)));
        }
        const book = buildBook(sample);
        if (book !== undefined) data.character_book = book;
        if (L.group_only_greetings !== undefined) data.group_only_greetings = [];
        if (L.avatar !== undefined) data.avatar = 'none';
        const activeChat = sample.activeChatSet ? humanizedDate(dateAdded + randInt(30 * 86400000)) : null;
        const card = {
            name, description: data.description, personality: data.personality, scenario: data.scenario,
            first_mes: data.first_mes, mes_example: data.mes_example, creatorcomment: undefined, avatar: undefined,
            chat: undefined, talkativeness: undefined, fav: undefined, tags: data.tags,
            spec: sample.spec, spec_version: sample.specVersion, data, create_date: createDate,
        };
        const top = sample.cardTop;
        if (top.creatorcomment) card.creatorcomment = data.creator_notes;
        if (top.avatar) card.avatar = 'none';
        if (top.chat && activeChat !== null) card.chat = activeChat;
        if (top.talkativeness) card.talkativeness = '0.5';
        if (top.fav) card.fav = sample.cardFav;
        cardPlan.push({
            id, dateAdded, card, tagIds, fav: !!sample.fav, activeChat,
            contentHash: sample.contentHashSet ? hex(32) : null, avatarIdentityHash: hex(32),
        });
    }
    mark('plannedMs');
    log('cards planned');

    let cardJsonBytes = 0;
    for (let i = 0; i < cardPlan.length; i += IMPORT_CHUNK) {
        const chunk = cardPlan.slice(i, i + IMPORT_CHUNK);
        await db.beginBatchImport(directories);
        for (const plan of chunk) {
            const cardJson = JSON.stringify(plan.card);
            cardJsonBytes += Buffer.byteLength(cardJson);
            clock = plan.dateAdded;
            await db.upsertCharacterFromWrite(directories, plan.id, cardJson, plan.contentHash, plan.avatarIdentityHash);
        }
        await db.setEntityTagIdsMany(directories, Object.fromEntries(chunk.map(plan => [plan.id, plan.tagIds])));
        await db.endBatchImport(directories);
    }
    clock = NOW_BASE;
    mark('importedMs');
    log(`${cardPlan.length} cards imported`);

    // fav and active_chat as live has them: set through their own writers, as the app sets them.
    for (const plan of cardPlan) {
        const built = await db.getCharacterFavsByIds(directories, [plan.id]);
        if (built[plan.id] !== plan.fav) await db.setCharacterFav(directories, plan.id, plan.fav);
        if (plan.activeChat !== null && plan.card.chat === undefined) await db.setCharacterActiveChat(directories, plan.id, plan.activeChat);
    }
    log('fav / active_chat set');

    // ---- groups: live's count, fav flags and tag counts, in live's rowid order ----
    const groupPlans = [];
    for (let g = 0; g < live.groups.length; g++) {
        const id = String(1740000000000 + g * 1234567 + randInt(1000000));
        const members = Array.from({ length: 2 + randInt(3) }, () => cardPlan[randInt(cardPlan.length)]);
        const memberNames = members.map(m => m.card.name.split(' ')[0]);
        const name = g % 2 === 0 ? `Group: ${memberNames.join(', ')}` : memberNames.join(' & ');
        const group = {
            id, name, members: members.map(m => m.id), avatar_url: undefined, allow_self_responses: false, activation_strategy: 0,
            generation_mode: 0, disabled_members: [], fav: live.groups[g].fav, chat_id: id, chats: [id], auto_mode_delay: 5,
            generation_mode_join_prefix: '', generation_mode_join_suffix: '',
        };
        fs.mkdirSync(directories.groups, { recursive: true });
        await writeGroupFile(directories, group);
        groupPlans.push({ id, tagIds: drawTags(live.groups[g].ntags).map(t => t.id) });
    }
    if (groupPlans.length > 0) await db.setEntityTagIdsMany(directories, Object.fromEntries(groupPlans.map(g => [g.id, g.tagIds])));
    log(`${groupPlans.length} groups`);

    // ---- meta: every boot flag and one-time pass marker done, as on live ----
    const migrationKeys = [
        'bootstrap_completed', 'groups_bootstrap_completed', 'group_numeric_id_recovery_v1', 'group_fav_normalized_v1',
        'tags_json_migrated', 'character_fav_normalized_v1', 'character_tag_ids_normalized_v1', 'unimport_embedded_lore_completed',
    ];
    for (const key of migrationKeys) await db.markMigrationComplete(directories, key);
    await db.setMetaValue(directories, 'card_tags_backfill_completed', '1');
    await db.setMetaValue(directories, 'tag_ids_shallow_json_backfill_completed', '1');
    // Unused leftover key live still carries.
    await db.setMetaValue(directories, 'tantivy_char_index_tags_hash', crypto.createHash('sha256').update(String(seed)).digest('hex'));
    fs.mkdirSync(directories.characters, { recursive: true });
    await db.setMetaValue(directories, 'last_reconcile_dir_mtime_ms', String(fs.statSync(directories.characters).mtimeMs));
    db.disposeMetadataStores();
    mark('metaMs');

    // ---- search index: built and caught up ----
    const indexDir = path.join(directories.root, 'search-index', 'characters-tantivy');
    let tickResult;
    {
        const tantivyModule = await getTantivyModule();
        if (!tantivyModule) throw new Error('tantivy backend unavailable');
        const maintainer = createCharacterIndexMaintainer(directories, tantivyModule);
        await maintainer.rebuild();
        tickResult = await maintainer.tick();
        maintainer.close();
        log(`index rebuilt at seq ${maintainer.seq()}, tick: ${JSON.stringify(tickResult)}`);
    }
    db.disposeMetadataStores();
    mark('indexMs');

    // ---- WAL checkpointed (TRUNCATE) and closed ----
    const dbPath = path.join(directories.root, 'character-metadata.sqlite');
    {
        const raw = new Database(dbPath, { fileMustExist: true });
        raw.pragma('wal_checkpoint(TRUNCATE)');
        raw.close();
    }

    // ---- report ----
    const made = termCounter(tantivy, indexDir);
    const words = wordPlan.map(e => ({
        term: e.term, field: e.field, liveDocs: e.liveDocs, liveShare: e.liveShare, target: e.target, eligible: e.eligible,
        placed: e.placed, reached: made.count(e.field, e.term),
    }));
    const shortfalls = words.filter(w => w.placed < w.target)
        .map(w => ({ term: w.term, field: w.field, target: w.target, eligible: w.eligible, short: w.target - w.placed }));
    const mismatches = words.filter(w => w.reached !== w.placed)
        .map(w => ({ term: w.term, field: w.field, placed: w.placed, reached: w.reached }));

    const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
    const one = (sql) => ro.prepare(sql).get();
    const report = {
        cards: one('SELECT COUNT(*) AS n FROM characters').n,
        tags: one('SELECT COUNT(*) AS n FROM tags').n,
        groups: one('SELECT COUNT(*) AS n FROM groups').n,
        characterTags: one('SELECT COUNT(*) AS n FROM character_tags').n,
        groupTags: one('SELECT COUNT(*) AS n FROM group_tags').n,
        cardJsonAvgBytes: Math.round(cardJsonBytes / cardPlan.length),
        indexNumDocs: made.numDocs,
        indexNumDocsEqualsCards: made.numDocs === cardCount,
        changesMaxSeq: one('SELECT MAX(seq) AS m FROM changes').m,
        indexSeq: one('SELECT value FROM meta WHERE key = \'tantivy_char_index_seq\'')?.value ?? null,
        meta: Array.from(ro.prepare('SELECT key, value FROM meta ORDER BY key LIMIT 100').iterate()),
        live: {
            numDocs: liveNumDocs,
            characterSamples: live.samples.length,
            tagCount: live.tagCount,
            tagCountCapped: live.tagCountCapped,
            groups: live.groups.length,
            groupsCapped: live.groupsCapped,
            replacedSpecs: live.replacedSpecs,
            replacedExtKeys: live.replacedExtKeys,
        },
        params: { cardCount, seed, terms, configPath, scratchRoot },
        words,
        shortfalls,
        mismatches,
        tick: tickResult,
        timings: { ...timings, totalMs: Math.round(performance.now() - t0) },
    };
    ro.close();
    log('done');
    return report;
}

// ---------------------------------------------------------------- entry points

function parseCliArgs(argv) {
    const opts = { userDir: null, scratch: null, config: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        switch (a) {
            case '--user-dir': opts.userDir = path.resolve(next()); break;
            case '--scratch': opts.scratch = path.resolve(next()); break;
            case '--config': opts.config = path.resolve(next()); break;
            default: throw new Error(`unknown argument: ${a}`);
        }
    }
    if (!opts.userDir || !opts.scratch) throw new Error('usage: node scripts/bench-search-synth.mjs --user-dir <live user dir> --scratch <data root> [--config <file>]');
    return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain && process.argv[2] === '--child') {
    process.once('message', (args) => {
        runChild(args).then(
            (report) => process.send({ type: 'report', report }, () => process.exit(0)),
            (err) => {
                console.error(err);
                process.send({ type: 'error', error: err?.stack ?? String(err) }, () => process.exit(1));
            },
        );
    });
} else if (isMain) {
    try {
        const opts = parseCliArgs(process.argv.slice(2));
        const report = await generateSynthLibrary(opts.userDir, opts.scratch, DEFAULT_WORDS, DEFAULT_CARD_COUNT, DEFAULT_SEED, { configPath: opts.config });
        console.log(JSON.stringify(report, null, 1));
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
