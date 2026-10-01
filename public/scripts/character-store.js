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
 * The "keep recently used characters" setting: how many characters to keep beyond the current one (0 = off), and
 * which, most recently used first. Set by power-user.js through {@link setRecentCharacters}.
 */
let recentLimit = 0;
/** @type {string[]} */
let recentAvatars = [];

/**
 * The avatars of the characters extensions are shown, and the page keeps holding. The one place that decides it:
 * the open group's members, the current character, and with the setting on, the recently used ones.
 * @returns {string[]}
 */
function exposedAvatars() {
    const group = openGroupId !== null ? groupsStore.get(openGroupId) : undefined;
    // Members first, in member order, so a member's index doesn't move when one of them is opened in the editor.
    const avatars = Array.isArray(group?.members) ? [...new Set(group.members)] : [];
    const seen = new Set(avatars);
    const rest = [];
    for (const avatar of [this_avatar, ...recentAvatars]) {
        if (avatar === undefined || seen.has(avatar)) continue;
        seen.add(avatar);
        rest.push(avatar);
    }
    // By avatar, not by recency, so a character's index only moves when the set itself changes.
    rest.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return [...avatars, ...rest];
}

/**
 * Sets the "keep recently used characters" setting's characters. Ones the page doesn't hold yet are shown once
 * they're taken in; ones dropped from the list are let go of like any other.
 * @param {number} limit How many to keep; 0 turns it off.
 * @param {string[]} avatars Most recently used first.
 */
export function setRecentCharacters(limit, avatars) {
    recentLimit = Math.max(0, Math.trunc(Number(limit)) || 0);
    // The current character is the most recently used one, so it counts toward the number.
    const ordered = this_avatar !== undefined ? [this_avatar, ...avatars] : avatars;
    recentAvatars = recentLimit > 0 ? [...new Set(ordered)].slice(0, recentLimit) : [];
    refreshExposed();
}

/**
 * @returns {string[]} The setting's characters, most recently used first; empty when it's off.
 */
export function getRecentCharacters() {
    return [...recentAvatars];
}

/**
 * Puts a character first among the recently used, when the setting is on.
 * @param {string|undefined} avatar
 */
function noteRecentlyUsed(avatar) {
    if (recentLimit === 0 || avatar === undefined || recentAvatars[0] === avatar) return;
    recentAvatars = [avatar, ...recentAvatars.filter(a => a !== avatar)].slice(0, recentLimit);
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

/** @type {Set<() => Iterable<string>>} */
const heldCharacterKeepers = new Set();

/**
 * Registers a source of avatars the page must keep holding even though they aren't exposed: a character whose save
 * is still in flight, the one loaded in the editor.
 * @param {() => Iterable<string>} keeper
 * @returns {() => void} unregister function
 */
export function keepHeldCharacters(keeper) {
    heldCharacterKeepers.add(keeper);
    return () => heldCharacterKeepers.delete(keeper);
}

/** How long after what is exposed last changed the page lets go of characters it no longer needs. */
const RELEASE_DELAY_MS = 2000;
let releaseTimer;

function scheduleRelease() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseUnneededCharacters, RELEASE_DELAY_MS);
}

/**
 * Lets go of every held character that isn't exposed and that nothing keeps. Put off while one is still kept by
 * a keeper that can't be read.
 */
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

charactersStore.onChange((change) => {
    refreshExposed();
    if (change.op === 'created' || change.op === 'reset') scheduleRelease();
});
onExposedEntitiesChange(scheduleRelease);
// Catches groupsStore being rebuilt; the rebuilt store is assigned right after it is built, so look a turn later.
onAnyEntityStoreChange(store => {
    if (store !== charactersStore) queueMicrotask(refreshExposed);
});

/**
 * Makes the page hold a character it was handed, so it can be selected. Every held character is a full card: a
 * shallow row (from `/query`, `getMany()` or the cache) is refused; read it with `characterRepository.full()` first.
 * A character already held is kept as it is.
 * @param {Character} character
 * @returns {Character} the held character
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
 * Sets the currently selected character, keyed by avatar (`this_avatar`, the source of truth).
 * @param {string|object|undefined} value A character avatar, a character object, or undefined to clear. An avatar
 * must be one the page holds; a character object the page doesn't hold is taken in.
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
    // An avatar key names a character whether or not the page holds it; selectCharacterByAvatar() reads one it doesn't.
    const isAvatarKey = typeof id === 'string' && id !== '' && exposedCharacters[id] === undefined && !/^\d+$/.test(id);
    const avatar = isAvatarKey ? id : resolveCharacterRef(id)?.avatar;
    if (avatar === undefined) {
        return;
    }
    await selectCharacterByAvatar(avatar, { switchMenu });
}
