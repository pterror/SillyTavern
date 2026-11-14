import { TYPE } from '../library-codes.js';
import { userStore } from '../user-stores.js';

/**
 * What an entry's trigger and character filters are checked against for one generation: upstream's filter names a
 * character by its avatar file's name without the extension, and a tag by its key.
 * @param {import('../users.js').UserDirectoryList | undefined} directories
 * @param {string | null | undefined} avatar the speaking character's
 * @param {string} trigger
 * @returns {Promise<{ trigger: string, characterFilename?: string, characterTags?: string[] }>}
 */
export async function entryFilterContextOf(directories, avatar, trigger) {
    if (!avatar) return { trigger };
    const characterFilename = avatar.replace(/\.[^/.]+$/, '');
    if (!directories) return { trigger, characterFilename };
    const { lib } = await userStore(directories);
    const [id] = await lib.ids(TYPE.character, [avatar]);
    const [entity] = id === null ? [null] : await lib.entities([id]);
    const [characterTags] = entity ? await lib.tagKeys([entity]) : [[]];
    return { trigger, characterFilename, characterTags };
}
