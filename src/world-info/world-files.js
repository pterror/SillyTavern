import extract from 'png-chunks-extract';

import { newWorldInfoEntryTemplate } from '../../public/scripts/world-info-entry-defaults.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_WORLD_KEYWORD = 'naidata';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const NOT_A_WORLD = 'This file isn\'t a world: it holds no entries SillyTavern, NovelAI, Agnai or Risu can make.';

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.filter(k => typeof k === 'string' && k.trim() !== '') : []);
const text = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '');
const finite = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * @param {Record<string, unknown>[]} entries
 * @returns {{ entries: Record<string, Record<string, unknown>> }}
 */
function worldOfEntries(entries) {
    /** @type {Record<string, Record<string, unknown>>} */
    const out = {};
    entries.forEach((fields, index) => {
        /** @type {Record<string, unknown>} */
        const entry = { ...structuredClone(newWorldInfoEntryTemplate), uid: index, displayIndex: index };
        for (const [field, value] of Object.entries(fields)) if (value !== undefined) entry[field] = value;
        out[String(index)] = entry;
    });
    return { entries: out };
}

/**
 * A NovelAI lorebook: `entries` of `{ displayName, text, keys, enabled, forceActivation, contextConfig: { budgetPriority } }`.
 * @param {Record<string, any>} book
 */
function fromNovel(book) {
    const entries = Array.isArray(book.entries) ? book.entries.filter(isPlainObject) : [];
    return worldOfEntries(entries.map(e => ({
        key: strings(e.keys),
        comment: text(e.displayName),
        content: text(e.text),
        disable: e.enabled === false,
        constant: e.forceActivation === true,
        order: finite(e.contextConfig?.budgetPriority),
    })));
}

/**
 * An Agnai memory book: `kind: 'memory'`, `entries` of `{ name, entry, keywords, weight, enabled }`; a higher weight is
 * placed later.
 * @param {Record<string, any>} book
 */
function fromAgnai(book) {
    const entries = Array.isArray(book.entries) ? book.entries.filter(isPlainObject) : [];
    return worldOfEntries(entries.map(e => ({
        key: strings(e.keywords),
        comment: text(e.name),
        content: text(e.entry),
        disable: e.enabled === false,
        order: finite(e.weight),
    })));
}

/**
 * @param {unknown} keys
 * @param {boolean} regex
 */
function risuKeys(keys, regex) {
    if (typeof keys !== 'string' || keys.trim() === '') return [];
    if (regex) return [`/${keys}/`];
    return keys.split(',').map(k => k.trim()).filter(k => k !== '');
}

/**
 * A Risu lorebook: `type: 'risu'`, `data` of `{ key, secondkey, comment, content, alwaysActive, selective, useRegex,
 * insertorder, activationPercent, mode }`; keys are one comma-separated text, or one regular expression with
 * `useRegex`; an entry of mode `folder` groups others and holds no lore.
 * @param {Record<string, any>} book
 */
function fromRisu(book) {
    const entries = Array.isArray(book.data) ? book.data.filter(e => isPlainObject(e) && e.mode !== 'folder') : [];
    return worldOfEntries(entries.map(e => {
        const percent = finite(e.activationPercent);
        return {
            key: risuKeys(e.key, e.useRegex === true),
            keysecondary: risuKeys(e.secondkey, e.useRegex === true),
            comment: text(e.comment),
            content: text(e.content),
            constant: e.alwaysActive === true,
            selective: e.selective === true,
            order: finite(e.insertorder),
            ...(percent === undefined ? {} : { probability: Math.min(100, Math.max(0, percent)), useProbability: true }),
        };
    }));
}

/**
 * @param {Buffer} bytes
 * @returns {unknown}
 */
function worldInPng(bytes) {
    /** @type {{ name: string, data: Uint8Array }[]} */
    let chunks;
    try {
        chunks = extract(new Uint8Array(bytes));
    } catch {
        return undefined;
    }
    const texts = chunks.filter(c => c.name === 'tEXt').map(c => Buffer.from(c.data));
    const found = texts.find(chunk => chunk.indexOf(0) !== -1 && chunk.subarray(0, chunk.indexOf(0)).toString('latin1') === PNG_WORLD_KEYWORD);
    if (!found) return undefined;
    try {
        return JSON.parse(Buffer.from(found.subarray(found.indexOf(0) + 1).toString('latin1'), 'base64').toString('utf8'));
    } catch {
        return undefined;
    }
}

/**
 * The world a file holds: upstream's world file, upstream's PNG with a world in it, or a NovelAI, Agnai or Risu book.
 * @param {Buffer} bytes
 * @returns {{ world: Record<string, unknown> } | { refused: string }}
 */
export function worldFromFile(bytes) {
    /** @type {unknown} */
    let data;
    if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        data = worldInPng(bytes);
        if (data === undefined) return { refused: 'This picture has no world in it.' };
    } else {
        try {
            data = JSON.parse((bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM) ? bytes.subarray(UTF8_BOM.length) : bytes).toString('utf8'));
        } catch {
            return { refused: NOT_A_WORLD };
        }
    }
    if (!isPlainObject(data)) return { refused: NOT_A_WORLD };
    const book = /** @type {Record<string, any>} */ (data);
    if (book.lorebookVersion !== undefined) return { world: fromNovel(book) };
    if (book.kind === 'memory') return { world: fromAgnai(book) };
    if (book.type === 'risu') return { world: fromRisu(book) };
    if (isPlainObject(book.entries)) return { world: book };
    return { refused: NOT_A_WORLD };
}
