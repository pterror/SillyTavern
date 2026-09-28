/**
 * What a character's primary lorebook link (`data.extensions.world`) points at. The browser
 * (world-info.js's getCharacterWorldLink()) and the server (src/endpoints/worldinfo.js's
 * getCharacterWorldLink()) both answer through {@link resolveCharacterWorldLink}, so prompts, the globe
 * and the Link to World Info popup agree.
 * @readonly
 * @enum {string}
 */
export const character_world_link = Object.freeze({
    /** The card links no lorebook. */
    NONE: 'none',
    /** A World file with the linked name exists. It is the one used, even if the card also embeds a book. */
    FILE: 'file',
    /** No World file has the linked name, and the card embeds its own lorebook (`data.character_book`), whatever that book's name. Prompts use the embedded book. */
    EMBEDDED: 'embedded',
    /** No World file has the linked name, and the card embeds no lorebook. */
    MISSING: 'missing',
});

/**
 * Works out what a character's primary lorebook link points at.
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character The character card
 * @param {(name: string) => boolean} worldFileExists Whether a World file exists under a name
 * @returns {string} One of {@link character_world_link}
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
