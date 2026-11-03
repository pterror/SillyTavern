import { EntityStore } from './entity-store.js';
import { getRequestHeaders } from './request-headers.js';

/** @type {Group[]} */
export const groups = [];
/** @type {EntityStore<Group>} */
export const groupsStore = new EntityStore(groups, g => g.id);

const READ_BATCH_SIZE = 500;

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, Group>>}
 */
export async function readGroups(ids) {
    /** @type {Map<string, Group>} */
    const found = new Map();
    const distinct = [...new Set(ids)];
    for (let start = 0; start < distinct.length; start += READ_BATCH_SIZE) {
        const response = await fetch('/api/groups/batch', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ids: distinct.slice(start, start + READ_BATCH_SIZE) }),
        });
        if (!response.ok) throw new Error(`/api/groups/batch responded ${response.status}`);
        for (const group of await response.json()) found.set(String(group.id), group);
    }
    return found;
}

/**
 * @param {string[]} ids
 * @param {(group: Group) => Group} take
 * @returns {Promise<Map<string, Group>>}
 */
async function heldOrRead(ids, take) {
    /** @type {Map<string, Group>} */
    const found = new Map();
    const missing = [];
    for (const id of ids) {
        const group = groupsStore.get(id);
        if (group) found.set(id, group);
        else missing.push(id);
    }
    if (missing.length === 0) return found;
    for (const [id, group] of await readGroups(missing)) found.set(id, take(group));
    return found;
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, Group>>} The groups of `ids` that exist, held from now on.
 */
export function holdGroups(ids) {
    return heldOrRead(ids, holdGroup);
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, Group>>} The groups of `ids` that exist; the ones not held stay not held.
 */
export function getGroupRows(ids) {
    return heldOrRead(ids, group => group);
}

/**
 * @param {Group} group A whole group as the server sends it.
 * @returns {Group}
 */
export function holdGroup(group) {
    const held = groupsStore.get(group.id);
    if (held) return held;
    groupsStore.create(group);
    return group;
}

/**
 * @param {string} name
 * @returns {Promise<string|null>} The id of the group with that name, or null if there is none.
 */
export async function findGroupByName(name) {
    const response = await fetch('/api/characters/find', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ type: 'group', name }),
    });
    if (!response.ok) throw new Error(`/api/characters/find responded ${response.status}`);
    const { ids } = await response.json();
    return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : null;
}

/** @type {Set<() => Iterable<string|null|undefined>>} */
const heldGroupKeepers = new Set();

/**
 * @param {() => Iterable<string|null|undefined>} keeper Names the groups the page shows.
 * @returns {() => void}
 */
export function keepHeldGroups(keeper) {
    heldGroupKeepers.add(keeper);
    return () => heldGroupKeepers.delete(keeper);
}

const RELEASE_DELAY_MS = 2000;
let releaseTimer;

export function releaseUnshownGroupsSoon() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseUnshownGroups, RELEASE_DELAY_MS);
}

function releaseUnshownGroups() {
    const keep = new Set();
    try {
        for (const keeper of heldGroupKeepers) {
            for (const id of keeper()) {
                if (typeof id === 'string') keep.add(id);
            }
        }
    } catch (error) {
        console.error('Could not tell which groups to keep holding:', error);
        releaseUnshownGroupsSoon();
        return;
    }
    const unshown = groups.map(group => group.id).filter(id => !keep.has(id));
    for (const id of unshown) groupsStore.remove(id);
}

groupsStore.onChange((change) => {
    if (change.op === 'created') releaseUnshownGroupsSoon();
});
