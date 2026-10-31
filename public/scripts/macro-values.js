import { getRequestHeaders } from './request-headers.js';
import { macrosIn, mentionAboutMacro } from './safe-macros.js';

/** @type {() => import('../../src/macro-facts.js').PageMacroFacts} */
let pageMacroFacts = () => ({});

/**
 * @param {() => import('../../src/macro-facts.js').PageMacroFacts} facts
 */
export function setPageMacroFacts(facts) {
    pageMacroFacts = facts;
}

/**
 * @typedef {object} MacroScope
 * @property {string} [avatar_url]
 * @property {string} [group_id]
 * @property {string | null} [at]
 * @property {string} [name2]
 */

/**
 * @typedef {object} Batch
 * @property {MacroScope} scope
 * @property {boolean} all
 * @property {string[]} macros
 * @property {Promise<(string | null)[]>} answer
 */

/** @type {Map<string, Batch>} */
const batches = new Map();

/**
 * @param {Batch} batch
 * @returns {Promise<(string | null)[]>}
 */
async function send(batch) {
    await Promise.resolve();
    batches.delete(JSON.stringify([batch.scope, batch.all]));
    const { macros, scope, all } = batch;
    try {
        const response = await fetch('/api/macros/values', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...scope, macros, all, macro_facts: pageMacroFacts() }),
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const { values } = await response.json();
        return macros.map((_, i) => (typeof values?.[i] === 'string' ? values[i] : null));
    } catch (error) {
        console.error('Could not fill in macros:', error);
        return macros.map(() => null);
    }
}

/**
 * @param {string[]} macros
 * @param {MacroScope} scope
 * @param {{ all?: boolean }} [options]
 * @returns {Promise<(string | null)[]>}
 */
export async function fetchMacroValues(macros, scope, { all = false } = {}) {
    if (macros.length === 0) return [];
    const key = JSON.stringify([scope, all]);
    let batch = batches.get(key);
    if (!batch) {
        batch = { scope, all, macros: [], answer: null };
        batch.answer = send(batch);
        batches.set(key, batch);
    }
    const start = batch.macros.length;
    batch.macros.push(...macros);
    const values = await batch.answer;
    return values.slice(start, start + macros.length);
}

export class MacroValues {
    /** @param {() => MacroScope} scope */
    constructor(scope) {
        this.scope = scope;
        /** @type {Map<string, string | null>} */
        this.values = new Map();
        /** @type {Map<string, Promise<void>>} */
        this.asked = new Map();
        this.scopeKey = '';
    }

    /** @returns {MacroScope} */
    currentScope() {
        const scope = this.scope();
        const key = JSON.stringify(scope);
        if (key !== this.scopeKey) {
            this.scopeKey = key;
            this.values = new Map();
            this.asked = new Map();
        }
        return scope;
    }

    /**
     * @param {string} source
     * @returns {string | null | undefined}
     */
    get(source) {
        this.currentScope();
        return this.values.get(source);
    }

    get valueOf() {
        return (/** @type {string} */ source) => this.get(source);
    }

    /**
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    async want(text) {
        return this.wantMacros(macrosIn(text));
    }

    /**
     * @param {string[]} sources
     * @returns {Promise<boolean>}
     */
    async wantMacros(sources) {
        sources = [...sources, ...sources.map(source => mentionAboutMacro(/^\{\{\s*([^\s:{}]+)\s*\}\}$/.exec(source)?.[1] ?? '')).filter(Boolean)];
        const scope = this.currentScope();
        const { values: learned, asked } = this;
        const missing = [...new Set(sources)].filter(source => !this.values.has(source) && !this.asked.has(source));
        const waiting = [...new Set(sources)].map(source => this.asked.get(source)).filter(Boolean);
        if (missing.length > 0) {
            const asking = fetchMacroValues(missing, scope).then((values) => {
                missing.forEach((source, i) => {
                    learned.set(source, values[i]);
                    asked.delete(source);
                });
            });
            for (const source of missing) asked.set(source, asking);
            waiting.push(asking);
        }
        await Promise.all(waiting);
        return missing.length > 0 && learned === this.values;
    }

    /**
     * @returns {Promise<boolean>}
     */
    async refresh() {
        const scope = this.currentScope();
        const known = this.values;
        const sources = [...known.keys()];
        if (sources.length === 0) return false;
        const values = await fetchMacroValues(sources, scope);
        if (known !== this.values) return false;
        let changed = false;
        sources.forEach((source, i) => {
            if (known.get(source) !== values[i]) changed = true;
            known.set(source, values[i]);
        });
        return changed;
    }
}

/**
 * @param {string} text
 * @param {MacroScope} scope
 * @returns {Promise<MacroValues>}
 */
export async function macroValuesOf(text, scope) {
    const values = new MacroValues(() => scope);
    await values.want(text);
    return values;
}
