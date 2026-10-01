import { EntityStore, onAnyEntityStoreChange } from './entity-store.js';
import { groupsStore } from './group-store.js';
import { selectCharacterByAvatar } from '../script.js';

/**
 * Every character the page holds. First-party code only: extensions get {@link exposedCharacters}.
 * @type {Character[]}
 */
export let characters = [];
// Wraps the same `characters` array in place; never reassigned to a new reference (unlike `tags`), so no
// rebuild-on-reassignment hook is needed.
export const charactersStore = new EntityStore(characters, c => c.avatar);

// Source of truth for character selection. Never assign directly - go through setCharacterId().
export let this_avatar;

/**
 * Upstream's `characters` as extensions see it, through script.js's export and `getContext().characters`: the
 * current character, or the open group's members the page holds, and no other character. A lookup for any other
 * character misses, as upstream's does for one that doesn't exist. A plain array updated in place, so a reference
 * kept from earlier stays current. Upstream's indices (`this_chid`, `getContext().characterId`, index arguments)
 * are positions in it.
 * @type {Character[]}
 */
export const exposedCharacters = [];

/**
 * Upstream's `groups` as extensions see it, through group-chats.js's export and `getContext().groups`: the open
 * group, and no other. A plain array updated in place.
 * @type {Group[]}
 */
export const exposedGroups = [];

/** @type {string|null} */
let openGroupId = null;

/** @type {Set<() => void>} */
const exposedListeners = new Set();

// Back-compat shim for third-party extensions/upstream parity only (index of the selected character in
// `exposedCharacters`, as a string, or undefined) - see .eslintrc.cjs's no-restricted-syntax rule forbidding
// first-party use. this_avatar/getCurrentCharacter()/charactersStore are the real source of truth.
//
// A plain ESM named export can't be a true per-read getter (no way to attach one to a module binding),
// so this is kept fresh via live-binding reassignment whenever `exposedCharacters` is refreshed.
export let this_chid;

/**
 * The avatars of the characters extensions are shown. The one place that decides it: today the current character
 * and the open group's members. The coming compat setting adds up to N more here, the most recently used.
 * @returns {string[]}
 */
function exposedAvatars() {
    const group = openGroupId !== null ? groupsStore.get(openGroupId) : undefined;
    // Members first, in member order, so a member's index doesn't move when one of them is opened in the editor.
    const avatars = Array.isArray(group?.members) ? [...new Set(group.members)] : [];
    if (this_avatar !== undefined && !avatars.includes(this_avatar)) avatars.push(this_avatar);
    return avatars;
}

/**
 * @param {any[]} array
 * @param {any[]} items
 * @returns {boolean} whether `array` changed
 */
function replaceInPlace(array, items) {
    if (array.length === items.length && array.every((item, i) => item === items[i])) return false;
    array.length = 0;
    array.push(...items);
    return true;
}

/** @type {EntityStore<Group>|null} */
let watchedGroupsStore = null;

function refreshExposed() {
    // groupsStore is rebuilt on every refetch, so the listener has to follow it.
    if (watchedGroupsStore !== groupsStore) {
        watchedGroupsStore = groupsStore;
        groupsStore.onChange(refreshExposed);
    }
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
 * Calls `listener` whenever {@link exposedCharacters} or {@link exposedGroups} changes.
 * @param {() => void} listener
 * @returns {() => void} unsubscribe function
 */
export function onExposedEntitiesChange(listener) {
    exposedListeners.add(listener);
    return () => exposedListeners.delete(listener);
}

/**
 * Records which group is open, for what extensions are shown. group-chats.js calls it whenever its
 * `selected_group` changes.
 * @param {string|null|undefined} groupId
 */
export function setExposedGroupId(groupId) {
    openGroupId = groupId === null || groupId === undefined ? null : String(groupId);
    refreshExposed();
}

charactersStore.onChange(() => refreshExposed());
// Catches groupsStore being rebuilt; the rebuilt store is assigned right after it is built, so look a turn later.
onAnyEntityStoreChange(store => {
    if (store !== charactersStore) queueMicrotask(refreshExposed);
});

/**
 * Sets the currently selected character, keyed by avatar (`this_avatar`, the source of truth).
 * @param {string|object|undefined} value A character avatar, a character object, or undefined to clear.
 */
export function setCharacterId(value) {
    switch (typeof value) {
        case 'string':
            this_avatar = charactersStore.has(value) ? value : undefined;
            break;
        case 'object': {
            // Identify by avatar rather than by object reference - the object may be a fresh reload of the
            // same character (different reference, same avatar), which should still resolve.
            const avatar = value?.avatar;
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
    refreshExposed();
}

/**
 * `characters[ref]` is upstream's lookup, kept verbatim so every value resolves exactly as upstream's does,
 * quirks included: `'03'` and `1.5` miss, `[3]` and `3n` hit, and `'length'` returns the length, not a character.
 * It reads {@link exposedCharacters}, the collection `getContext().characters` returns, since that is where indices
 * come from.
 * The avatar and object forms are fork-only and apply only where upstream misses; no avatar key is all digits,
 * so they never collide with an index.
 * @param {any} ref An index into `getContext().characters`, an avatar key, or a character object
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
 * For a call that passed a character in both its upstream form and the fork-only avatar form. Unless both name
 * the same character, returns {@link CHARACTER_REF_MISMATCH}, and the caller applies its own upstream miss
 * behaviour. That includes only one resolving: using it would be guessing.
 * The avatar form is only ever an avatar key, never an index, so `'2'` there names no character.
 * @param {any} ref The upstream form, resolved with {@link resolveCharacterRef}
 * @param {any} avatar The fork-only avatar form
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
 * Thin wrapper around selectCharacterByAvatar(), kept for the public extension API (context.selectCharacterById).
 * @param {any} id Anything {@link resolveCharacterRef} accepts
 * @param {{switchMenu?: boolean}} [options]
 */
export async function selectCharacterById(id, { switchMenu = true } = {}) {
    const avatar = resolveCharacterRef(id)?.avatar;
    if (avatar === undefined) {
        return;
    }
    await selectCharacterByAvatar(avatar, { switchMenu });
}
