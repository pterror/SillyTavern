import { characters, charactersStore } from './character-store.js';
import { groupsStore } from './group-store.js';

/** @type {string?} */
export let active_character = '';

/** @type {string?} */
export let active_group = '';

export const default_user_name = 'User';

export let name1 = default_user_name;

/**
 * Raw mutator for name1, with no notification/save side effects - those live in script.js's
 * setUserName, which calls this to write the value.
 * @param {string} value
 */
export function setName1Raw(value) {
    name1 = value;
}

// Same resolution contract as tags.js's getTagKeyForEntity, reimplemented here against
// character-store.js/group-store.js (both leaves) instead of importing tags.js, so this module carries no
// back-edge into tags.js's part of the import cycle. The one behavioral difference from tags.js's version:
// this skips its resolveTagIdsArray side effect of eagerly creating an empty tag_ids array on the resolved
// character/group - every other reader of tag_ids in the codebase already guards with Array.isArray(), so
// nothing depends on that array existing before it's first read.
function resolveEntityKey(entityOrKey) {
    let x = entityOrKey;
    if (typeof x === 'object' && x !== null && 'id' in x) x = x.id;
    let character;
    if (!character && characters.indexOf(x) >= 0) character = x;
    if (!character && !isNaN(parseInt(entityOrKey))) character = characters[x];
    if (!character) character = charactersStore.get(x);
    if (character) x = character.avatar;
    return x && (charactersStore.has(x) || groupsStore.has(x)) ? x : undefined;
}

/**
 * Sets the currently active character
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active character is reset to `null`.
 */
export function setActiveCharacter(entityOrKey) {
    active_character = entityOrKey ? resolveEntityKey(entityOrKey) : null;
    if (active_character) active_group = null;
}

/**
 * Sets the currently active group.
 * @param {object|number|string} [entityOrKey] - An entity with id property (character, group, tag), or directly an id or tag key. If not provided, the active group is reset to `null`.
 */
export function setActiveGroup(entityOrKey) {
    active_group = entityOrKey ? resolveEntityKey(entityOrKey) : null;
    if (active_group) active_character = null;
}

// script.js's settings-load site writes here directly, not through setActiveCharacter/setActiveGroup:
// those setters resolve their argument against charactersStore/groupsStore, which are still empty at
// settings-load time, and would wipe the saved value back to null/undefined on every page load.
export function setActiveCharacterAndGroupFromSettings(character, group) {
    active_character = character;
    active_group = group;
}
