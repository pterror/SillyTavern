import { EntityStore } from './entity-store.js';
import { selectCharacterByAvatar } from '../script.js';

/** @type {Character[]} */
export let characters = [];
// Wraps the same `characters` array in place; never reassigned to a new reference (unlike `tags`), so no
// rebuild-on-reassignment hook is needed.
export const charactersStore = new EntityStore(characters, c => c.avatar);

// Source of truth for character selection. Never assign directly - go through setCharacterId().
export let this_avatar;

// Back-compat shim for third-party extensions/upstream parity only (index of the selected character in
// `characters`, as a string, or undefined) - see .eslintrc.cjs's no-restricted-syntax rule forbidding
// first-party use. this_avatar/getCurrentCharacter()/charactersStore are the real source of truth.
//
// A plain ESM named export can't be a true per-read getter (no way to attach one to a module binding),
// so this is kept fresh via live-binding reassignment on every event that could change the answer: not
// just selection changes, but also any charactersStore add/remove, since that can shift every other
// character's index even when the selection itself hasn't changed.
export let this_chid;

function recomputeThisChid() {
    const index = this_avatar !== undefined ? characters.findIndex(c => c.avatar === this_avatar) : -1;
    this_chid = index !== -1 ? String(index) : undefined;
}

charactersStore.onChange(() => recomputeThisChid());

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
    recomputeThisChid();
}

/**
 * `characters[ref]` is upstream's lookup, kept verbatim so every value resolves exactly as upstream's does,
 * quirks included: `'03'` and `1.5` miss, `[3]` and `3n` hit, and `'length'` returns `characters.length`, not a
 * character. It must read the collection `getContext().characters` returns, since that is where indices come from.
 * The avatar and object forms are fork-only and apply only where upstream misses; no avatar key is all digits,
 * so they never collide with an index.
 * @param {any} ref An index into `getContext().characters`, an avatar key, or a character object
 * @returns {Character|undefined}
 */
export function resolveCharacterRef(ref) {
    const upstreamHit = characters[ref];
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
