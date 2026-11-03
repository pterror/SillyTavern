import { EntityStore, onAnyEntityStoreChange } from './entity-store.js';
import { groupsStore } from './group-store.js';
import { selectCharacterByAvatar } from '../script.js';

/** @type {Character[]} */
export let characters = [];
export const charactersStore = new EntityStore(characters, c => c.avatar);

export let this_avatar;

/** @type {Character[]} */
export const exposedCharacters = [];

/** @type {Group[]} */
export const exposedGroups = [];

/** @type {string|null} */
let openGroupId = null;

/** @type {Set<() => void>} */
const exposedListeners = new Set();

// `exposedCharacters`, as a string, or undefined) - see .eslintrc.cjs's no-restricted-syntax rule forbidding
export let this_chid;

let recentLimit = 0;
/** @type {string[]} */
let recentAvatars = [];

/**
 * @returns {string[]}
 */
function exposedAvatars() {
    const group = openGroupId !== null ? groupsStore.get(openGroupId) : undefined;
    const avatars = Array.isArray(group?.members) ? [...new Set(group.members)] : [];
    const seen = new Set(avatars);
    const rest = [];
    for (const avatar of [this_avatar, ...recentAvatars]) {
        if (avatar === undefined || seen.has(avatar)) continue;
        seen.add(avatar);
        rest.push(avatar);
    }
    rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...avatars, ...rest];
}

/**
 * @param {number} limit
 * @param {string[]} avatars
 */
export function setRecentCharacters(limit, avatars) {
    recentLimit = Math.max(0, Math.trunc(Number(limit)) || 0);
    const ordered = this_avatar !== undefined ? [this_avatar, ...avatars] : avatars;
    recentAvatars = recentLimit > 0 ? [...new Set(ordered)].slice(0, recentLimit) : [];
    refreshExposed();
}

/**
 * @returns {string[]}
 */
export function getRecentCharacters() {
    return [...recentAvatars];
}

/**
 * @param {string|undefined} avatar
 */
function noteRecentlyUsed(avatar) {
    if (recentLimit === 0 || avatar === undefined || recentAvatars[0] === avatar) return;
    recentAvatars = [avatar, ...recentAvatars.filter(a => a !== avatar)].slice(0, recentLimit);
}

/**
 * @param {any[]} array
 * @param {any[]} items
 * @returns {boolean}
 */
function replaceInPlace(array, items) {
    if (array.length === items.length && array.every((item, i) => item === items[i])) return false;
    array.length = 0;
    array.push(...items);
    return true;
}

function refreshExposed() {
    const nextCharacters = exposedAvatars().map(avatar => charactersStore.get(avatar)).filter(Boolean);
    const group = openGroupId !== null ? groupsStore.get(openGroupId) : undefined;
    const charactersChanged = replaceInPlace(exposedCharacters, nextCharacters);
    const groupsChanged = replaceInPlace(exposedGroups, group ? [group] : []);
    const index = this_avatar !== undefined ? exposedCharacters.findIndex(c => c.avatar === this_avatar) : -1;
    this_chid = index !== -1 ? String(index) : undefined;
    if (charactersChanged || groupsChanged) {
        for (const listener of exposedListeners) listener();
    }
}

/**
 * @param {string|undefined} avatar
 * @returns {number|undefined}
 */
export function exposedIndexOf(avatar) {
    const index = avatar === undefined ? -1 : exposedCharacters.findIndex(c => c.avatar === avatar);
    return index === -1 ? undefined : index;
}

/**
 * @param {() => void} listener
 * @returns {() => void}
 */
export function onExposedEntitiesChange(listener) {
    exposedListeners.add(listener);
    return () => exposedListeners.delete(listener);
}

/**
 * @param {string|null|undefined} groupId
 */
export function setExposedGroupId(groupId) {
    openGroupId = groupId === null || groupId === undefined ? null : String(groupId);
    refreshExposed();
}

/** @type {Set<() => Iterable<string>>} */
const heldCharacterKeepers = new Set();

/**
 * @param {() => Iterable<string>} keeper
 * @returns {() => void}
 */
export function keepHeldCharacters(keeper) {
    heldCharacterKeepers.add(keeper);
    return () => heldCharacterKeepers.delete(keeper);
}

const RELEASE_DELAY_MS = 2000;
let releaseTimer;

function scheduleRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseUnneededCharacters, RELEASE_DELAY_MS);
}

function releaseUnneededCharacters() {
    const keep = new Set(exposedAvatars());
    try {
        for (const keeper of heldCharacterKeepers) {
            for (const avatar of keeper()) keep.add(avatar);
        }
    } catch (error) {
        console.error('Could not tell which characters to keep holding:', error);
        scheduleRelease();
        return;
    }
    const unneeded = characters.map(character => character.avatar).filter(avatar => !keep.has(avatar));
    for (const avatar of unneeded) charactersStore.remove(avatar);
}

groupsStore.onChange(refreshExposed);
charactersStore.onChange((change) => {
    refreshExposed();
    if (change.op === 'created' || change.op === 'reset') scheduleRelease();
});
onExposedEntitiesChange(scheduleRelease);
onAnyEntityStoreChange(store => {
    if (store !== charactersStore) queueMicrotask(refreshExposed);
});

/**
 * @param {Character} character
 * @returns {Character}
 */
export function holdCharacter(character) {
    const held = charactersStore.get(character.avatar);
    if (held) return held;
    if (character.shallow === true) {
        throw new TypeError(`Only a full character can be held, not the shallow row of ${character.avatar}`);
    }
    charactersStore.create(character);
    return character;
}

/**
 * @param {string|object|undefined} value
 */
export function setCharacterId(value) {
    switch (typeof value) {
        case 'string':
            this_avatar = charactersStore.has(value) ? value : undefined;
            break;
        case 'object': {
            const avatar = value?.avatar;
            if (typeof avatar === 'string' && avatar !== '') holdCharacter(value);
            this_avatar = (avatar !== undefined && charactersStore.has(avatar)) ? avatar : undefined;
            break;
        }
        case 'undefined':
            this_avatar = undefined;
            break;
        default:
            console.error('Invalid character ID type:', value);
            break;
    }
    noteRecentlyUsed(this_avatar);
    refreshExposed();
}

/**
 * @param {any} ref
 * @returns {Character|undefined}
 */
export function resolveCharacterRef(ref) {
    const upstreamHit = exposedCharacters[ref];
    if (upstreamHit !== undefined) {
        return upstreamHit;
    }
    if (typeof ref === 'string') {
        return charactersStore.get(ref);
    }
    if (typeof ref === 'object' && ref !== null && typeof ref.avatar === 'string') {
        return charactersStore.get(ref.avatar);
    }
    return undefined;
}

export const CHARACTER_REF_MISMATCH = Symbol('CHARACTER_REF_MISMATCH');

/**
 * @param {any} ref
 * @param {any} avatar
 * @returns {Character|typeof CHARACTER_REF_MISMATCH}
 */
export function resolveCharacterRefPair(ref, avatar) {
    const character = resolveCharacterRef(ref);
    if (typeof character?.avatar === 'string' && character.avatar === avatar) {
        return character;
    }
    console.warn('Character references do not resolve to the same character; treating as not found:', ref, avatar);
    return CHARACTER_REF_MISMATCH;
}

/**
 * @param {any} id
 * @param {{switchMenu?: boolean}} [options]
 */
export async function selectCharacterById(id, { switchMenu = true } = {}) {
    const isAvatarKey = typeof id === 'string' && id !== '' && exposedCharacters[id] === undefined && !/^\d+$/.test(id);
    const avatar = isAvatarKey ? id : resolveCharacterRef(id)?.avatar;
    if (avatar === undefined) {
        return;
    }
    await selectCharacterByAvatar(avatar, { switchMenu });
}
