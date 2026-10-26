import { STATEMENT_PREFIX, TYPE } from '../library-codes.js';
import { historyWrites } from '../entity-values.js';
import { draft } from './entity-draft.js';
import { USER_LISTS } from './refs.js';
import { FOLLOWS_TEXT_GENERATION } from './capabilities.js';
import { keysOf, readCatalog, readDraft, writeDrafts } from './model-store.js';

/**
 * A user's settings in the store (the settings model §1.2, step 9): the user record (`TYPE.user`, key the handle)
 * holding the user level's statements, the catalogs' entities, and the statements the user made at characters and
 * groups (STATEMENT_PREFIX values on them). Written from, and read back as, settings-compat.js's UserModel.
 *
 * The user record's values: `o:<field>` an override, `b:<group>` a bundle statement, `s:<slot>` a slot's statement
 * (text generation, the remembered connections, each capability, the proxy, profile, persona and regex preset, the
 * username kept, the data bank files turned off elsewhere), `ext:<key>` an extension's own settings, `key:<path>` an
 * unknown key. Its lists (refs.js USER_LISTS): the ordered regex scripts, regex presets and proxies, the data bank
 * files, the quick reply sets and the hidden ones, and the characters and groups holding its statements.
 */

/** The catalogs a user's entities are of, read back a page at a time. */
const CATALOG_TYPES = Object.freeze([
    TYPE.connection, TYPE.connectionProfile, TYPE.proxy, TYPE.persona, TYPE.serverHistory, TYPE.modelTemplateBinding,
    TYPE.regexScript, TYPE.regexPreset, TYPE.globalVariable, TYPE.dataBankFile, TYPE.biasList,
]);

const PAGE = 500;

/** A character's or group's statements, by what they state. */
const STATEMENTS = Object.freeze({
    personas: `${STATEMENT_PREFIX}personas`,
    dataBank: `${STATEMENT_PREFIX}dataBank`,
    quickReplies: `${STATEMENT_PREFIX}quickReplies`,
});

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {import('./settings-compat.js').UserModel} UserModel
 * @typedef {{ personas?: string[], dataBank?: string[], quickReplies?: { items: string[], hidden: string[] } }} HolderStatements
 */

/**
 * A capability's statement as a value: a connection's key (a ref), else JSON.
 * @param {string | null} statement
 */
function capabilityValue(statement) {
    if (statement === null) return null;
    return statement === FOLLOWS_TEXT_GENERATION ? { follows: FOLLOWS_TEXT_GENERATION } : statement;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function capabilityOf(value) {
    if (value && typeof value === 'object' && /** @type {any} */ (value).follows === FOLLOWS_TEXT_GENERATION) return FOLLOWS_TEXT_GENERATION;
    return typeof value === 'string' ? value : null;
}

/**
 * The statements the model makes at each character and group, by `character:<avatar>` or `group:<id>`.
 * @param {UserModel['statements']} statements
 * @returns {Map<string, { type: number, key: string, says: HolderStatements }>}
 */
function holdersOf(statements) {
    /** @type {Map<string, { type: number, key: string, says: HolderStatements }>} */
    const holders = new Map();
    const at = (/** @type {'character' | 'group'} */ kind, /** @type {string} */ key) => {
        const id = `${kind}:${key}`;
        if (!holders.has(id)) holders.set(id, { type: kind === 'group' ? TYPE.group : TYPE.character, key, says: {} });
        return /** @type {HolderStatements} */ (holders.get(id)?.says);
    };
    for (const { holder, personas } of statements.personasConnected ?? []) at(holder.type, holder.id).personas = personas;
    for (const { avatar, files } of statements.dataBank?.characters ?? []) at('character', avatar).dataBank = files;
    for (const { avatar, items, hidden } of statements.quickReplies?.characters ?? []) at('character', avatar).quickReplies = { items, hidden };
    return holders;
}

/**
 * The user record's draft.
 * @param {string} handle
 * @param {UserModel} model
 * @param {Map<string, { type: number, key: string }>} holders
 * @returns {EntityDraft}
 */
export function userDraftOf(handle, model, holders) {
    const { user, statements } = model;
    /** @type {Record<string, unknown>} */
    const values = {};
    for (const [field, value] of Object.entries(user.overrides)) values[`o:${field}`] = value;
    for (const [group, ref] of Object.entries(user.bundles)) values[`b:${group}`] = ref;
    const slot = (/** @type {string} */ name, /** @type {unknown} */ value) => {
        if (value !== undefined) values[`s:${name}`] = value;
    };
    slot('textGeneration', statements.textGeneration);
    for (const [family, key] of Object.entries(statements.remembered ?? {})) slot(`remembered.${family}`, key);
    for (const [name, statement] of Object.entries(statements.capabilities ?? {})) slot(`capability.${name}`, capabilityValue(statement));
    slot('proxy', statements.proxy);
    slot('profile', statements.profile);
    slot('persona', statements.persona);
    slot('regexPreset', statements.regexPreset);
    slot('username', statements.username);
    slot('disabledElsewhere', statements.dataBank?.disabledElsewhere);
    for (const [key, value] of Object.entries(model.ext)) values[`ext:${key}`] = value;
    for (const [key, value] of Object.entries(model.unknown)) values[`key:${key}`] = value;
    const holderList = (/** @type {number} */ type) => [...holders.values()].filter(h => h.type === type).map(h => h.key);
    // A list the model has, even empty, is written; one it hasn't isn't, so it reads back as not there.
    /** @type {Record<number, string[] | undefined>} */
    const lists = {
        [USER_LISTS.regexScripts]: statements.regexScripts,
        [USER_LISTS.regexPresets]: statements.regexPresets,
        [USER_LISTS.proxies]: model.entities.filter(e => e.type === TYPE.proxy).map(e => e.key),
        [USER_LISTS.dataBank]: statements.dataBank?.user,
        [USER_LISTS.quickReplySets]: statements.quickReplies?.user.items,
        [USER_LISTS.quickReplyHidden]: statements.quickReplies?.user.hidden,
        [USER_LISTS.characters]: holderList(TYPE.character),
        [USER_LISTS.groups]: holderList(TYPE.group),
    };
    if (statements.dataBank) values['s:dataBank'] = true;
    return draft(TYPE.user, handle, values, /** @type {Record<number, string[]>} */ (Object.fromEntries(Object.entries(lists).filter(([, items]) => items !== undefined))));
}

/**
 * Writes a user's model: the user record, the catalogs' entities, and the user's statements at characters and
 * groups (a character or group not in the library is left out, warned), as one commit.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} handle
 * @param {UserModel} model
 * @param {{ actor?: import('../world-info-engine.js').Actor | null, bundles?: EntityDraft[] }} [options] `bundles`:
 *   the bundles (presets, templates, themes, quick reply sets) written with it.
 * @returns {Promise<{ warnings: string[] }>}
 */
export async function writeUserModel(lib, handle, model, { actor = null, bundles = [] } = {}) {
    /** @type {string[]} */
    const warnings = [];
    const holders = holdersOf(model.statements);
    /** @type {[number, string][]} */
    const refs = [];
    for (const { type, key, says } of holders.values()) {
        refs.push([type, key]);
        for (const avatar of says.personas ?? []) refs.push([TYPE.persona, avatar]);
        for (const url of says.dataBank ?? []) refs.push([TYPE.dataBankFile, url]);
        for (const name of [...(says.quickReplies?.items ?? []), ...(says.quickReplies?.hidden ?? [])]) refs.push([TYPE.quickReplySet, name]);
    }
    const user = userDraftOf(handle, model, holders);
    await writeDrafts(lib, [...bundles, ...model.entities, user], {
        actor, warnings, refs,
        extra: async (ids, stamp) => {
            const writes = historyWrites(stamp);
            const idOf = (/** @type {number} */ type, /** @type {string} */ key) => ids.get(`${type}:${key}`);
            const records = [];
            for (const { type, key, says } of holders.values()) {
                const holder = idOf(type, key);
                if (holder === undefined) continue;
                const [stored] = await lib.entities([holder]);
                const ref = (/** @type {number} */ t, /** @type {string[]} */ keys) => keys.map(k => idOf(t, k)).filter(id => id !== undefined).map(String);
                /** @type {[string, unknown][]} */
                const next = [
                    [STATEMENTS.personas, says.personas && ref(TYPE.persona, says.personas)],
                    [STATEMENTS.dataBank, says.dataBank && ref(TYPE.dataBankFile, says.dataBank)],
                    [STATEMENTS.quickReplies, says.quickReplies && { items: ref(TYPE.quickReplySet, says.quickReplies.items), hidden: ref(TYPE.quickReplySet, says.quickReplies.hidden) }],
                ];
                for (const [field, value] of next) {
                    const before = stored?.values.find(v => v.field === field)?.json;
                    if (value === undefined) {
                        if (before !== undefined) records.push(...writes.delete(holder, field));
                        continue;
                    }
                    const json = JSON.stringify(value);
                    if (json !== before) records.push(...writes.json(holder, field, json, before));
                }
            }
            return records;
        },
    });
    return { warnings };
}

/**
 * Reads a user's model back.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} handle
 * @returns {Promise<UserModel | null>}
 */
export async function readUserModel(lib, handle) {
    const user = await readDraft(lib, TYPE.user, handle);
    if (!user) return null;
    /** @type {EntityDraft[]} */
    const entities = [];
    for (const type of CATALOG_TYPES) {
        let after = null;
        for (;;) {
            const page = await readCatalog(lib, type, { after, limit: PAGE });
            entities.push(...page.drafts);
            if (!page.more) break;
            after = page.last;
        }
    }
    // The proxies in the user's order.
    const proxyOrder = /** @type {string[]} */ (user.lists?.[USER_LISTS.proxies] ?? []);
    entities.sort((a, b) => (a.type === TYPE.proxy && b.type === TYPE.proxy ? proxyOrder.indexOf(a.key) - proxyOrder.indexOf(b.key) : 0));

    /** @type {UserModel['user']} */
    const level = { level: 'user', bundles: {}, overrides: {} };
    /** @type {Record<string, any>} */
    const statements = { remembered: {}, capabilities: {} };
    /** @type {unknown} */
    let disabledElsewhere;
    /** @type {Record<string, unknown>} */
    const ext = {};
    /** @type {Record<string, unknown>} */
    const unknown = {};
    for (const [field, value] of Object.entries(user.values)) {
        const name = field.slice(field.indexOf(':') + 1);
        if (field.startsWith('o:')) level.overrides[name] = value;
        else if (field.startsWith('b:')) level.bundles[name] = /** @type {string} */ (value);
        else if (field.startsWith('ext:')) ext[name] = value;
        else if (field.startsWith('key:')) unknown[name] = value;
        else if (name.startsWith('remembered.')) statements.remembered[name.slice('remembered.'.length)] = value;
        else if (name.startsWith('capability.')) statements.capabilities[name.slice('capability.'.length)] = capabilityOf(value);
        else if (name === 'disabledElsewhere') disabledElsewhere = value;
        else if (name !== 'dataBank') statements[name] = value;
    }
    /** The list as written; undefined for one the model hadn't. */
    const list = (/** @type {number} */ n) => /** @type {string[] | undefined} */ (user.lists?.[n]);
    if (list(USER_LISTS.regexScripts)) statements.regexScripts = list(USER_LISTS.regexScripts);
    if (list(USER_LISTS.regexPresets)) statements.regexPresets = list(USER_LISTS.regexPresets);
    if (user.values['s:dataBank'] === true) {
        statements.dataBank = { user: list(USER_LISTS.dataBank) ?? [], characters: [], disabledElsewhere: disabledElsewhere ?? [] };
    }
    if (list(USER_LISTS.quickReplySets)) {
        statements.quickReplies = { user: { items: list(USER_LISTS.quickReplySets), hidden: list(USER_LISTS.quickReplyHidden) ?? [] }, characters: [] };
    }
    statements.personasConnected = [];

    // The statements at characters and groups, refs back to keys.
    const holders = [
        ...(list(USER_LISTS.characters) ?? []).map(key => ({ type: TYPE.character, kind: 'character', key })),
        ...(list(USER_LISTS.groups) ?? []).map(key => ({ type: TYPE.group, kind: 'group', key })),
    ];
    for (const holder of holders) {
        const entity = await lib.entity(holder.type, holder.key);
        if (!entity) continue;
        const json = (/** @type {string} */ field) => {
            const v = entity.values.find(x => x.field === field)?.json;
            return v === undefined ? undefined : JSON.parse(v);
        };
        const personas = json(STATEMENTS.personas);
        const files = json(STATEMENTS.dataBank);
        const qr = json(STATEMENTS.quickReplies);
        const keys = await keysOf(lib, [...(personas ?? []), ...(files ?? []), ...(qr?.items ?? []), ...(qr?.hidden ?? [])].map(id => BigInt(id)));
        const named = (/** @type {string[]} */ ids) => ids.map(id => keys.get(id)).filter(k => k !== undefined);
        if (personas) statements.personasConnected.push({ holder: { type: holder.kind, id: holder.key }, personas: named(personas) });
        if (files) (statements.dataBank ??= { user: [], characters: [], disabledElsewhere: [] }).characters.push({ avatar: holder.key, files: named(files) });
        if (qr) (statements.quickReplies ??= { user: { items: [], hidden: [] }, characters: [] }).characters.push({ avatar: holder.key, items: named(qr.items), hidden: named(qr.hidden) });
    }
    return { user: level, entities, ext, unknown, elsewhere: {}, statements, secrets: [], warnings: [] };
}

