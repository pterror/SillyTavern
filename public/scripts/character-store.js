import { EntityStore } from './entity-store.js';
import { selectCharacterByAvatar } from '../script.js';

/** @type {Character[]} */
export let characters = [];
// Wraps the same `characters` array in place; never reassigned to a new reference (unlike `tags`), so no
// rebuild-on-reassignment hook is needed.
export const charactersStore = new EntityStore(characters, c => c.avatar);

// Source of truth for character selection. Never assign directly - go through setCharacterId().
export let this_avatar;

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
