import { EntityStore } from './entity-store.js';
import { groupsStore } from './group-store.js';

/** @type {Character[]} */
export let characters = [];
export const charactersStore = new EntityStore(characters, c => c.avatar);

export let this_avatar;

/** @type {string|null} */
let openGroupId = null;

/**
 * @returns {string[]}
 */
function openAvatars() {
    const group = openGroupId !== null ? groupsStore.get(openGroupId) : undefined;
    const avatars = Array.isArray(group?.members) ? [...group.members] : [];
    if (this_avatar !== undefined) avatars.push(this_avatar);
    return avatars;
}

/**
 * @param {string|null|undefined} groupId
 */
export function setOpenGroupId(groupId) {
    openGroupId = groupId === null || groupId === undefined ? null : String(groupId);
    scheduleRelease();
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
    const keep = new Set(openAvatars());
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

groupsStore.onChange(scheduleRelease);
charactersStore.onChange((change) => {
    if (change.op === 'created' || change.op === 'reset') scheduleRelease();
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
    scheduleRelease();
}
