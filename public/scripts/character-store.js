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
 * Thin wrapper around selectCharacterByAvatar(), kept for the public extension API (context.selectCharacterById).
 * @param {number|string} id
 * @param {{switchMenu?: boolean}} [options]
 */
export async function selectCharacterById(id, { switchMenu = true } = {}) {
    const avatar = characters[id]?.avatar;
    if (avatar === undefined) {
        return;
    }
    await selectCharacterByAvatar(avatar, { switchMenu });
}
