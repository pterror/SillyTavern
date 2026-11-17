import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';
import { FIELD, TYPE } from './library-codes.js';

/**
 * @typedef {object} GroupLike
 * @property {string} [name]
 * @property {string[]} [members]
 * @property {string[]} [disabled_members]
 */

/**
 * @typedef {object} Speakers
 * @property {string} name2
 * @property {Record<string, any> | null} character
 * @property {string[]} groupMembers
 * @property {string[]} groupDisabledMembers
 */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<Record<string, any> | null>}
 */
async function readCard(directories, avatar) {
    try {
        const raw = await readCardContent(directories, avatar);
        return raw === undefined ? null : JSON.parse(raw);
    } catch {
        return null;
    }
}

/** @param {Record<string, any> | null} card */
const nameOf = card => card?.name || card?.data?.name || '';

/** @param {import('./users.js').UserDirectoryList} directories @param {string} avatar */
async function readName(directories, avatar) {
    const { userStore } = await import('./user-stores.js');
    const { lib } = await userStore(directories);
    const [id] = await lib.ids(TYPE.character, [avatar]);
    const [entity] = await lib.entities([id], { fields: [FIELD.name, FIELD.creator_notes], lists: [] });
    return entity ? { name: entity.values.find(value => value.field === FIELD.name)?.text ?? '',
        data: { creator_notes: entity.values.find(value => value.field === FIELD.creator_notes)?.text ?? '' } } : null;
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ avatar?: string | null, groupId?: string | null }} who
 * @param {{ namesOnly?: boolean }} [options]
 * @returns {Promise<Speakers>}
 */
export async function resolveSpeakers(directories, { avatar, groupId }, { namesOnly = false } = {}) {
    const read = namesOnly ? readName : readCard;
    const character = avatar != null ? await read(directories, avatar) : null;
    let name2 = nameOf(character);
    /** @type {string[]} */
    const groupMembers = [];
    /** @type {string[]} */
    const groupDisabledMembers = [];
    const group = groupId != null ? /** @type {GroupLike | undefined} */ ((await getGroupsByIds(directories, [groupId]))[groupId]) : undefined;
    if (group) {
        if (avatar == null && group.name) name2 = group.name;
        const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
        for (const memberAvatar of Array.isArray(group.members) ? group.members : []) {
            const name = nameOf(await read(directories, memberAvatar));
            if (!name) continue;
            groupMembers.push(name);
            if (disabled.has(memberAvatar)) groupDisabledMembers.push(name);
        }
    }
    return { name2, character, groupMembers, groupDisabledMembers };
}
