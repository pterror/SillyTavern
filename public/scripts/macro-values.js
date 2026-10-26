// The values the page shows in macros' places (pills, previews, token counts), from the server, which fills in the
// prompts with the same engine and the same facts (src/endpoints/macros.js): the page never fills in macros for
// itself. A preview asks for the values its text needs before it renders, so it renders once, with them.
// What only the page knows of what the macros read is given to it (setPageMacroFacts()), so importing it never adds
// an import cycle.

import { getRequestHeaders } from './request-headers.js';
import { macrosIn, mentionAboutMacro } from './safe-macros.js';

/** @type {() => import('../../src/macro-facts.js').PageMacroFacts} What only the page knows, sent with each request. */
let pageMacroFacts = () => ({});

/**
 * Called as the page's macros load.
 * @param {() => import('../../src/macro-facts.js').PageMacroFacts} facts
 */
export function setPageMacroFacts(facts) {
    pageMacroFacts = facts;
}

/**
 * @typedef {object} MacroScope Whose macros: the chat's (`avatar_url`, `group_id`) at the message `at` (none: no chat);
 * `name2` names the character instead.
 * @property {string} [avatar_url]
 * @property {string} [group_id]
 * @property {string | null} [at]
 * @property {string} [name2]
 */

/**
 * @typedef {object} Batch Macros asked for in one task with the same scope, sent as one request.
 * @property {MacroScope} scope
 * @property {boolean} all
 * @property {string[]} macros
 * @property {Promise<(string | null)[]>} answer All the batch's values, in order.
 */

/** @type {Map<string, Batch>} The batches not sent yet, by scope. */
const batches = new Map();

/**
 * @param {Batch} batch
 * @returns {Promise<(string | null)[]>}
 */
async function send(batch) {
    // Every macro asked for in this task joins the batch first.
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
 * Each macro's value, in order: null for one that is filled in only when sent. With `all`, each is a text whose every
 * macro is filled in, nothing a macro sets kept. Values that can't be read are all null. Those asked for in the same
 * task with the same scope go in one request.
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

/**
 * The values of the macros one place shows (an editor, a preview), asked for as it finds them. Those learned for
 * another scope (another chat, a message since) are forgotten.
 */
export class MacroValues {
    /** @param {() => MacroScope} scope Read at each use. */
    constructor(scope) {
        this.scope = scope;
        /** @type {Map<string, string | null>} */
        this.values = new Map();
        /** @type {Map<string, Promise<void>>} */
        this.asked = new Map();
        /** The scope the values are for. */
        this.scopeKey = '';
    }

    /** @returns {MacroScope} The scope now, the values forgotten if it changed. */
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
     * @param {string} source A macro's `{{…}}`.
     * @returns {string | null | undefined} Its value; null when it is filled in only when sent; undefined when it
     * isn't known yet.
     */
    get(source) {
        this.currentScope();
        return this.values.get(source);
    }

    /** A function reading this store's values, as safe-macros.js takes one. */
    get valueOf() {
        return (/** @type {string} */ source) => this.get(source);
    }

    /**
     * Asks for the values not known yet of the macros a text has.
     * @param {string} text
     * @returns {Promise<boolean>} Whether a value was learned.
     */
    async want(text) {
        return this.wantMacros(macrosIn(text));
    }

    /**
     * @param {string[]} sources Macros' `{{…}}`.
     * @returns {Promise<boolean>} Whether a value was learned.
     */
    async wantMacros(sources) {
        // A mention's card shows who it names' description, filled in too.
        sources = [...sources, ...sources.map(source => mentionAboutMacro(/^\{\{\s*([^\s:{}]+)\s*\}\}$/.exec(source)?.[1] ?? '')).filter(Boolean)];
        const scope = this.currentScope();
        const { values: learned, asked } = this;
        const missing = [...new Set(sources)].filter(source => !this.values.has(source) && !this.asked.has(source));
        const waiting = [...new Set(sources)].map(source => this.asked.get(source)).filter(Boolean);
        if (missing.length > 0) {
            // Kept where they were asked for: another scope's values are not this one's.
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
     * Asks for every known value again (the time has moved on, a variable changed).
     * @returns {Promise<boolean>} Whether a value changed.
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
 * The values of a text's macros, asked for at once.
 * @param {string} text
 * @param {MacroScope} scope
 * @returns {Promise<MacroValues>}
 */
export async function macroValuesOf(text, scope) {
    const values = new MacroValues(() => scope);
    await values.want(text);
    return values;
}
