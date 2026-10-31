/* global BigInt */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const RECORD = process.env.RECORD_OLD_STORE === '1';
const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures', 'old-store');

function encode(/** @type {any} */ value, /** @type {any} */ directories) {
    return JSON.stringify(value, (_k, v) => {
        if (v === undefined) return { $u: 1 };
        if (typeof v === 'bigint') return { $big: v.toString() };
        if (v instanceof Map) return { $map: [...v] };
        if (v instanceof Set) return { $set: [...v] };
        if (directories && v === directories) return '<directories>';
        if (directories && v === directories.root) return '<root>';
        return v;
    });
}

function decode(/** @type {string} */ json) {
    return JSON.parse(json, (_k, v) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (v.$u === 1 && Object.keys(v).length === 1) return undefined;
            if (typeof v.$big === 'string' && Object.keys(v).length === 1) return BigInt(v.$big);
            if (Array.isArray(v.$map) && Object.keys(v).length === 1) return new Map(v.$map);
            if (Array.isArray(v.$set) && Object.keys(v).length === 1) return new Set(v.$set);
        }
        return v;
    });
}

const hashOf = (/** @type {string} */ json) => crypto.createHash('sha256').update(json).digest('hex').slice(0, 16);

const pick = (/** @type {any} */ o, /** @type {string[]} */ keys) => (o && typeof o === 'object' ? Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, o[k]])) : o);

/** @type {Record<string, (value: any, args: any[]) => any>} */
const KEPT = {
    queryEntities: v => (v && typeof v === 'object' ? {
        ...v,
        ...(v.rows ? { rows: v.rows.map((/** @type {any} */ r) => pick(r, ['id', 'fav', 'date_added', 'date_last_chat', 'chat_size'])) } : {}),
        ...(v.hashRows ? { hashRows: v.hashRows.map((/** @type {any} */ h) => pick(h, ['id', 'favHash', 'tagIdsHash'])) } : {}),
    } : v),
    queryTags: (v, args) => (v && typeof v === 'object' && v.rows && !args[1]?.ids && args[1]?.pageSize !== 50 ? { ...v, rows: v.rows.map((/** @type {any} */ r) => pick(r, ['id'])) } : v),
};

/**
 * @param {string} root
 */
function filesUnder(root) {
    /** @type {Map<string, string>} */
    const out = new Map();
    const walk = (/** @type {string} */ dir) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, d.name);
            const rel = path.relative(root, full);
            if (rel === 'store' || /\.sqlite(-wal|-shm|-journal)?$/.test(d.name)) continue;
            if (d.isDirectory()) walk(full);
            else if (d.isFile()) out.set(rel, fs.readFileSync(full).toString('base64'));
        }
    };
    if (fs.existsSync(root)) walk(root);
    return out;
}

function filesChanged(/** @type {Map<string, string>} */ before, /** @type {Map<string, string>} */ after) {
    /** @type {Record<string, string | null>} */
    const changed = {};
    for (const [p, b] of after) if (before.get(p) !== b) changed[p] = b;
    for (const p of before.keys()) if (!after.has(p)) changed[p] = null;
    return Object.keys(changed).length ? changed : undefined;
}

function applyFiles(/** @type {string} */ root, /** @type {Record<string, string | null>} */ changed) {
    for (const [p, b] of Object.entries(changed)) {
        const full = path.join(root, p);
        if (b === null) {
            fs.rmSync(full, { force: true });
        } else {
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, Buffer.from(b, 'base64'));
        }
    }
}

const isThenable = (/** @type {any} */ v) => v && typeof v.then === 'function';
const isAsyncIterable = (/** @type {any} */ v) => v && typeof v[Symbol.asyncIterator] === 'function';

async function* replayBatches(/** @type {any[]} */ batches) {
    for (const batch of batches) yield batch;
}

const fixtureName = (/** @type {string} */ testName) => `${testName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)}-${hashOf(JSON.stringify(testName)).slice(0, 8)}.json`;

/**
 * @param {string} suite
 * @param {string} module
 * @param {() => any} directoriesOf
 * @param {{ files?: boolean }} [options]
 */
export async function oldStoreOracle(suite, module, directoriesOf, { files: trackFiles = true } = {}) {
    const dir = path.join(FIXTURES, suite);
    const exportsFile = path.join(dir, 'exports.json');
    /** @type {any} */
    const real = RECORD ? await import(path.join(import.meta.dirname, '..', '..', 'src', module)) : null;
    /** @type {Map<string, EventEmitter>} */
    const emitters = new Map();
    /** @type {any[]} */
    let log = [];
    let at = 0;
    let name = '';

    /** @type {Record<string, any>} */
    let exported = {};
    if (real) {
        for (const [key, value] of Object.entries(real)) {
            if (value instanceof EventEmitter) {
                const local = new EventEmitter();
                emitters.set(key, local);
                exported[key] = { $emitter: true };
                const realEmit = value.emit.bind(value);
                value.emit = (/** @type {string} */ event, /** @type {any[]} */ ...args) => {
                    if (local.listenerCount(event)) {
                        log.push({ event, emitter: key, args: encode(args, directoriesOf()) });
                        local.emit(event, ...args);
                    }
                    return realEmit(event, ...args);
                };
            } else if (typeof value !== 'function') {
                exported[key] = encode(value, null);
            }
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(exportsFile, JSON.stringify(exported) + '\n');
    } else {
        exported = fs.existsSync(exportsFile) ? JSON.parse(fs.readFileSync(exportsFile, 'utf8')) : {};
        for (const [key, value] of Object.entries(exported)) if (value?.$emitter) emitters.set(key, new EventEmitter());
    }

    function replay(/** @type {string} */ fn, /** @type {any[]} */ args) {
        const entry = log[at++];
        const got = encode(args, directoriesOf());
        if (!entry || entry.fn !== fn || entry.args !== hashOf(got)) {
            throw new Error(`old store call ${at - 1} of "${name}" was ${fn}(${got.slice(0, 300)}), recorded ${entry ? `a call to ${entry.fn}` : 'nothing'}${entry?.fn === fn ? ' with other arguments' : ''}`);
        }
        if (entry.files) applyFiles(directoriesOf().root, entry.files);
        while (log[at]?.event !== undefined) {
            const e = log[at++];
            emitters.get(e.emitter)?.emit(e.event, ...decode(e.args));
        }
        const value = decode(entry.result);
        const answer = value && typeof value === 'object' && Array.isArray(value.$batches) ? replayBatches(value.$batches) : value;
        return entry.async === false ? answer : Promise.resolve(answer);
    }

    function record(/** @type {string} */ fn, /** @type {any[]} */ args) {
        /** @type {{ fn: string, args: string, result: string, async?: boolean, files?: Record<string, string | null> }} */
        const entry = { fn, args: hashOf(encode(args, directoriesOf())), result: '' };
        log.push(entry);
        const root = trackFiles ? directoriesOf()?.root : undefined;
        const before = root ? filesUnder(root) : new Map();
        const keep = (/** @type {any} */ kept) => {
            entry.result = encode(kept, directoriesOf());
            const files = root ? filesChanged(before, filesUnder(root)) : undefined;
            if (files) entry.files = files;
        };
        const out = real[fn](...args);
        if (!isThenable(out)) {
            entry.async = false;
            keep(KEPT[fn] ? KEPT[fn](out, args) : out);
            return out;
        }
        return out.then(async (/** @type {any} */ value) => {
            if (!isAsyncIterable(value)) {
                keep(KEPT[fn] ? KEPT[fn](value, args) : value);
                return value;
            }
            const batches = [];
            for await (const batch of value) batches.push(batch);
            keep({ $batches: batches });
            return replayBatches(batches);
        });
    }

    /** @type {any} */
    const store = new Proxy({}, {
        get(_t, prop) {
            if (typeof prop !== 'string') return undefined;
            if (emitters.has(prop)) return emitters.get(prop);
            if (Object.hasOwn(exported, prop)) return decode(exported[prop]);
            if (prop.startsWith('dispose')) return (/** @type {any[]} */ ...args) => real?.[prop](...args);
            return (/** @type {any[]} */ ...args) => (real ? record(prop, args) : replay(prop, args));
        },
    });

    function begin(/** @type {string} */ testName) {
        name = testName;
        at = 0;
        const file = path.join(dir, fixtureName(testName));
        log = RECORD ? [] : fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).calls : [];
    }

    function end() {
        if (RECORD) {
            fs.mkdirSync(dir, { recursive: true });
            if (log.length) fs.writeFileSync(path.join(dir, fixtureName(name)), JSON.stringify({ test: name, calls: log }) + '\n');
            return;
        }
        if (at !== log.length) throw new Error(`"${name}" made ${at} of the ${log.length} old store calls recorded`);
    }

    return { store, begin, end };
}
