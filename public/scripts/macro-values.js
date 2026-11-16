import { getRequestHeaders } from './request-headers.js';
import { macrosIn, mentionAboutMacro } from './safe-macros.js';

/** @type {() => import('../../src/macro-facts.js').PageMacroFacts} */
let pageMacroFacts = () => ({});

/**
 * @typedef {{ keys: Record<string, any>, expectedHashes: Record<string, number> }} SettingsChanges
 * @typedef {object} SettingsCarrier the page's settings changes the server hasn't been sent, which a request for values
 *   carries so the values are filled in from the settings as the page has them
 * @property {() => SettingsChanges | undefined} take
 * @property {(answer: any, sent: Record<string, any>) => Promise<void>} saved
 * @property {(conflictingKeys?: string[]) => Promise<void>} conflicted
 * @property {(changes: SettingsChanges) => void} returned
 */

/** @type {SettingsCarrier} */
let settingsCarrier = { take: () => undefined, saved: async () => {}, conflicted: async () => {}, returned: () => {} };

/**
 * @param {SettingsCarrier} carrier
 */
export function setSettingsCarrier(carrier) {
    settingsCarrier = carrier;
}

/**
 * @param {Response} response
 * @returns {any} the answer to the settings changes a request carried, which the server names in a header
 */
function settingsSavedOf(response) {
    const header = response.headers.get('X-ST-Settings-Saved');
    if (!header) return null;
    try {
        return JSON.parse(decodeURIComponent(header));
    } catch {
        return null;
    }
}

/**
 * @param {() => import('../../src/macro-facts.js').PageMacroFacts} facts
 */
export function setPageMacroFacts(facts) {
    pageMacroFacts = facts;
}

/** @returns {import('../../src/macro-facts.js').PageMacroFacts} */
export function currentPageMacroFacts() {
    return pageMacroFacts();
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
    const changes = settingsCarrier.take();
    /** @type {Response | null} */
    let response = null;
    try {
        response = await fetch('/api/macros/values', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...scope, macros, all, macro_facts: pageMacroFacts(), ...(changes ? { settings_changes: changes } : {}) }),
        });
        const answer = await response.json().catch(() => null);
        if (changes) {
            const saved = settingsSavedOf(response);
            if (saved) await settingsCarrier.saved(saved, changes.keys);
            else if (answer?.settings_not_saved) await settingsCarrier.conflicted(answer.conflictingKeys ?? undefined);
            else settingsCarrier.returned(changes);
        }
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const values = answer?.values;
        return macros.map((_, i) => (typeof values?.[i] === 'string' ? values[i] : null));
    } catch (error) {
        if (changes && !response) settingsCarrier.returned(changes);
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

/**
 * The values of a scope's macros: what every text drawn in the scope (a message, its editor, an alternative, a preview,
 * the chat box) draws its macros with
 * @typedef {object} HeldScope
 * @property {MacroScope} scope as it was last asked with
 * @property {Map<string, string | null>} values each macro's value, by its source; null when only known when sent
 * @property {Map<string, Promise<void>>} asked the macros asked for and not answered yet
 * @property {number} version how many times its values changed, for setups to tell drawings with older values
 * @property {object} epoch what an answer to a question must still be asked under to be taken
 */

/**
 * The page's values of macros, by scope. A scope is the chat or card the values are filled in from and the speaker
 * (`name2`, none for the person); where the chat is read up to (`at`) is the latest when asked, not part of the scope.
 * @type {Map<string, HeldScope>}
 */
const held = new Map();

/** @type {() => void} */
let heard = () => {};
let hearing = false;

/**
 * @param {() => void} listener hears, once after a run of changes, that the values of some scope changed
 */
export function onMacroValuesChanged(listener) {
    heard = listener;
}

function changed() {
    if (hearing) return;
    hearing = true;
    queueMicrotask(() => {
        hearing = false;
        heard();
    });
}

/**
 * Says the chat the page's texts are drawn in changed: every text is drawn again in the scope it is in now, and asks for
 * the values it lacks there
 */
export function macroScopesChanged() {
    changed();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const named = value => (typeof value === 'string' && value !== '' ? value : null);

/**
 * @param {MacroScope} scope
 * @returns {string}
 */
export function macroScopeKey(scope) {
    return JSON.stringify([named(scope.avatar_url), named(scope.group_id), typeof scope.name2 === 'string' ? scope.name2 : null]);
}

/**
 * @param {MacroScope} scope
 * @returns {HeldScope}
 */
function heldScope(scope) {
    const key = macroScopeKey(scope);
    let entry = held.get(key);
    if (!entry) {
        entry = { scope, values: new Map(), asked: new Map(), version: 0, epoch: {} };
        held.set(key, entry);
    }
    entry.scope = scope;
    return entry;
}

/**
 * @param {HeldScope} entry
 * @param {[string, string | null][]} values
 */
function learn(entry, values) {
    let any = false;
    for (const [source, value] of values) {
        if (entry.values.get(source) === value && entry.values.has(source)) continue;
        entry.values.set(source, value);
        any = true;
    }
    if (!any) return false;
    entry.version += 1;
    changed();
    return true;
}

/**
 * @param {unknown} values
 * @returns {[string, string | null][]}
 */
function valuesIn(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    return Object.entries(values).flatMap(([source, value]) => (typeof value === 'string' || value === null ? [[source, value]] : []));
}

/**
 * @param {MacroScope} scope
 * @returns {number} how many times the scope's values changed: a drawing made with an older number is drawn again
 */
function macroValuesVersion(scope) {
    return held.get(macroScopeKey(scope))?.version ?? 0;
}

/**
 * @typedef {{ speaker: string | null, values: Record<string, string | null> }} ScopeValues the values of the macros a
 *   speaker's texts draw, as an answer carries them: for the person when the speaker is null
 */

/**
 * @param {MacroScope} owner
 * @param {string | null} speaker
 * @returns {MacroScope}
 */
const speakerScope = (owner, speaker) => {
    const rest = { ...owner };
    delete rest.name2;
    return speaker === null ? rest : { ...rest, name2: speaker };
};

/**
 * Takes the values of macros an answer carries, for the chat or card it answers about
 * @param {MacroScope} owner the chat or card: `avatar_url` or `group_id`
 * @param {unknown} answered the answer's `ScopeValues` list
 */
export function takeMacroValues(owner, answered) {
    if (!Array.isArray(answered)) return;
    for (const each of answered) {
        if (!each || typeof each !== 'object' || (each.speaker !== null && typeof each.speaker !== 'string')) continue;
        const values = valuesIn(each.values);
        if (values.length) learn(heldScope(speakerScope(owner, each.speaker)), values);
    }
}

/**
 * Takes the values of macros a text in a scope came with
 * @param {MacroScope} scope
 * @param {unknown} values each macro's source to its value
 */
export function takeScopeMacroValues(scope, values) {
    const taken = valuesIn(values);
    if (taken.length) learn(heldScope(scope), taken);
}

/**
 * @typedef {{ avatar_url?: string, group_id?: string, speaker: string | null }} HeldScopeName a scope as a request
 *   names it: its chat or card, none for neither, and its speaker
 */

/**
 * The macros the page holds values of, by scope, for an action that may change every value to be answered with their
 * values now
 * @returns {(HeldScopeName & { sources: string[] })[]}
 */
export function heldMacroSources() {
    return [...held.values()].flatMap((entry) => {
        if (entry.values.size === 0) return [];
        const avatar = named(entry.scope.avatar_url);
        const group = named(entry.scope.group_id);
        return [{
            ...(avatar ? { avatar_url: avatar } : {}),
            ...(group ? { group_id: group } : {}),
            speaker: typeof entry.scope.name2 === 'string' ? entry.scope.name2 : null,
            sources: [...entry.values.keys()],
        }];
    });
}

/**
 * The macros the page holds values of for the person in any chat or card, for opening a chat to be answered with their
 * values in it: what texts drawn for the open chat, not one speaker's, draw
 * @returns {string[]}
 */
export function heldPersonMacroSources() {
    const sources = new Set();
    for (const entry of held.values()) {
        if (typeof entry.scope.name2 !== 'string') for (const source of entry.values.keys()) sources.add(source);
    }
    return [...sources];
}

/**
 * Takes an answer to an action that may have changed every value, carrying the values of every macro the page held
 * (`heldMacroSources`): they replace the page's, and a scope's the answer has none of are dropped, to be asked for
 * again where they are drawn. A question asked before is answered into nothing.
 * @param {unknown} answered the answer's list: each scope's name (`HeldScopeName`) with its `values`
 */
export function replaceMacroValues(answered) {
    /** @type {Map<string, { scope: MacroScope, values: Map<string, string | null> }>} */
    const fresh = new Map();
    for (const each of Array.isArray(answered) ? answered : []) {
        if (!each || typeof each !== 'object' || (each.speaker !== null && typeof each.speaker !== 'string')) continue;
        const owner = { ...(named(each.avatar_url) ? { avatar_url: each.avatar_url } : {}), ...(named(each.group_id) ? { group_id: each.group_id } : {}) };
        const scope = speakerScope(owner, each.speaker);
        fresh.set(macroScopeKey(scope), { scope, values: new Map(valuesIn(each.values)) });
    }
    let any = false;
    for (const [key, entry] of held) {
        if (entry.asked.size) any = true;
        entry.asked = new Map();
        entry.epoch = {};
        const values = fresh.get(key)?.values ?? new Map();
        fresh.delete(key);
        if (values.size === entry.values.size && [...values].every(([source, value]) => entry.values.has(source) && entry.values.get(source) === value)) continue;
        entry.values = values;
        entry.version += 1;
        any = true;
    }
    for (const [key, { scope, values }] of fresh) {
        held.set(key, { scope, values, asked: new Map(), version: 1, epoch: {} });
        any = true;
    }
    if (any) changed();
}

/**
 * A scope's macros' values, as every text drawn in it reads them. One asked for that isn't known is asked of the server
 * with the others asked for in the same moment.
 */
export class MacroValues {
    /** @param {() => MacroScope} scope the scope as it is now, `at` included */
    constructor(scope) {
        this.scope = scope;
    }

    /**
     * @param {string} source
     * @returns {string | null | undefined} undefined while it isn't known
     */
    get(source) {
        return held.get(macroScopeKey(this.scope()))?.values.get(source);
    }

    get valueOf() {
        return (/** @type {string} */ source) => this.get(source);
    }

    /**
     * The value of a macro a text being drawn shows: one not known is asked for, and the text drawn again when it comes
     * @param {string} source
     * @returns {string | null | undefined}
     */
    read(source) {
        const value = this.get(source);
        if (value === undefined) void this.wantMacros([source]);
        return value;
    }

    /** @returns {number} */
    version() {
        return macroValuesVersion(this.scope());
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
     * @returns {Promise<boolean>} whether values were learned
     */
    async wantMacros(sources) {
        sources = [...new Set([...sources, ...sources.map(source => mentionAboutMacro(/^\{\{\s*([^\s:{}]+)\s*\}\}$/.exec(source)?.[1] ?? '')).filter(Boolean)])];
        const scope = this.scope();
        const entry = heldScope(scope);
        const missing = sources.filter(source => !entry.values.has(source) && !entry.asked.has(source));
        const waiting = sources.map(source => entry.asked.get(source)).filter(Boolean);
        let learned = false;
        if (missing.length > 0) {
            const { epoch } = entry;
            const asking = fetchMacroValues(missing, scope).then((values) => {
                if (entry.epoch !== epoch) return;
                for (const source of missing) entry.asked.delete(source);
                learned = learn(entry, missing.map((source, i) => [source, values[i]]));
            });
            for (const source of missing) entry.asked.set(source, asking);
            waiting.push(asking);
        }
        await Promise.all(waiting);
        return learned;
    }

    /**
     * Asks for the values held of some macros again, since an edit may have changed them
     * @param {string[]} written the macros
     * @returns {Promise<boolean>} whether any changed
     */
    async refresh(written) {
        const scope = this.scope();
        const entry = held.get(macroScopeKey(scope));
        const sources = entry ? written.filter(source => entry.values.has(source)) : [];
        if (!entry || sources.length === 0) return false;
        const { epoch } = entry;
        const values = await fetchMacroValues(sources, scope);
        if (entry.epoch !== epoch) return false;
        return learn(entry, sources.map((source, i) => [source, values[i]]));
    }
}
