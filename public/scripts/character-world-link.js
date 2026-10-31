/**
 * @readonly
 * @enum {string}
 */
export const character_world_link = Object.freeze({
    NONE: 'none',
    FILE: 'file',
    EMBEDDED: 'embedded',
    MISSING: 'missing',
});

/**
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 * @param {(name: string) => boolean} worldFileExists
 * @returns {string}
 */
export function resolveCharacterWorldLink(character, worldFileExists) {
    const name = character?.data?.extensions?.world;
    if (!name) {
        return character_world_link.NONE;
    }
    if (worldFileExists(name)) {
        return character_world_link.FILE;
    }
    if (character?.data?.character_book) {
        return character_world_link.EMBEDDED;
    }
    return character_world_link.MISSING;
}
