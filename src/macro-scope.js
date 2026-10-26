import { readCardContent } from './endpoints/characters.js';
import { getGroupsByIds } from './endpoints/groups.js';

/**
 * Who a prompt is built for, as the macros and the prompt builders read it: the one place the server reads a
 * character's and a group's names for them.
 */

/**
 * @typedef {object} GroupLike The fields read off a group (getGroupsByIds() leaves its records untyped).
 * @property {string} [name]
 * @property {string[]} [members] Member avatars.
 * @property {string[]} [disabled_members] Muted member avatars.
 */

/**
 * @typedef {object} Speakers
 * @property {string} name2 The character's name; with no character, the group's.
 * @property {Record<string, any> | null} character The character's card, parsed.
 * @property {string[]} groupMembers Every member's name, muted ones too.
 * @property {string[]} groupDisabledMembers The muted members' names.
 */

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar
 * @returns {Promise<Record<string, any> | null>} Null for a card that isn't there or can't be read.
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

/**
 * The character (by avatar) and the group (by id) a prompt is built for. A member whose card can't be read is left
 * out.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {{ avatar?: string | null, groupId?: string | null }} who
 * @returns {Promise<Speakers>}
 */
export async function resolveSpeakers(directories, { avatar, groupId }) {
    const character = avatar != null ? await readCard(directories, avatar) : null;
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
            const name = nameOf(await readCard(directories, memberAvatar));
            if (!name) continue;
            groupMembers.push(name);
            if (disabled.has(memberAvatar)) groupDisabledMembers.push(name);
        }
    }
    return { name2, character, groupMembers, groupDisabledMembers };
}
