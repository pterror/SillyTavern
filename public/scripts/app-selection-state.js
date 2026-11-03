import { characters, charactersStore } from './character-store.js';
import { groupsStore } from './group-store.js';

/** @type {string?} */
export let active_character = '';

/** @type {string?} */
export let active_group = '';

export const default_user_name = 'User';

export let name1 = default_user_name;

/**
 * @param {string} value
 */
export function setName1Raw(value) {
    name1 = value;
}

function resolveEntityKey(entityOrKey) {
    let x = entityOrKey;
    if (typeof x === 'object' && x !== null && 'id' in x) x = x.id;
    let character;
    if (!character && characters.indexOf(x) >= 0) character = x;
    if (!character) character = charactersStore.get(x);
    if (character) x = character.avatar;
    return x && (charactersStore.has(x) || groupsStore.has(x)) ? x : undefined;
}

/**
 * @param {object|number|string} [entityOrKey]
 */
export function setActiveCharacter(entityOrKey) {
    active_character = entityOrKey ? resolveEntityKey(entityOrKey) : null;
    if (active_character) active_group = null;
}

/**
 * @param {object|number|string} [entityOrKey]
 */
export function setActiveGroup(entityOrKey) {
    active_group = entityOrKey ? resolveEntityKey(entityOrKey) : null;
    if (active_group) active_character = null;
}

export function setActiveCharacterAndGroupFromSettings(character, group) {
    active_character = character;
    active_group = group;
}
