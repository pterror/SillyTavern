import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { downloadChubLorebook, isLinkedLorebookFetchAllowed } from './endpoints/content-manager.js';
import { importWorldInfoFromRaw } from './endpoints/worldinfo.js';
import { userStore } from './user-stores.js';

/**
 * Gets the path to the sprites folder for the provided character name
 * @param {import('./users.js').UserDirectoryList} directories - User directories
 * @param {string} name - The name of the character
 * @param {boolean} isSubfolder - Whether the name contains a subfolder
 * @returns {string | null} The path to the sprites folder. Null if the name is invalid.
 */
function getSpritesPath(directories, name, isSubfolder) {
    if (isSubfolder) {
        const nameParts = name.split('/');
        const characterName = sanitize(nameParts[0]);
        const subfolderName = sanitize(nameParts[1]);

        if (!characterName || !subfolderName) {
            return null;
        }

        return path.join(directories.characters, characterName, subfolderName);
    }

    name = sanitize(name);

    if (!name) {
        return null;
    }

    return path.join(directories.characters, name);
}

/**
 * Imports base64 encoded sprites from RisuAI character data.
 * The sprites are saved in the character's sprites folder.
 * The additionalAssets and emotions are removed from the data.
 * @param {import('./users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 * @param {string | null} [avatarFileName] The character's avatar identity (id, no extension): the folder the sprites
 * are written to. Falls back to the display name when not yet known.
 * @returns {void}
 */
export function importRisuSprites(directories, data, avatarFileName = null) {
    try {
        const name = data?.data?.name;
        const risuData = data?.data?.extensions?.risuai;

        // Not a Risu AI character
        if (!risuData || !name) {
            return;
        }

        let images = [];

        if (Array.isArray(risuData.additionalAssets)) {
            images = images.concat(risuData.additionalAssets);
        }

        if (Array.isArray(risuData.emotions)) {
            images = images.concat(risuData.emotions);
        }

        // No sprites to import
        if (images.length === 0) {
            return;
        }

        // Create sprites folder if it doesn't exist
        const folderName = avatarFileName || name;
        const spritesPath = getSpritesPath(directories, folderName, false);

        // Invalid sprites path
        if (!spritesPath) {
            return;
        }

        // Create sprites folder if it doesn't exist
        if (!fs.existsSync(spritesPath)) {
            fs.mkdirSync(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!fs.statSync(spritesPath).isDirectory()) {
            return;
        }

        console.info(`RisuAI: Found ${images.length} sprites for ${name}. Writing to disk.`);
        const files = fs.readdirSync(spritesPath);

        outer: for (const [label, fileBase64] of images) {
            // Remove existing sprite with the same label
            for (const file of files) {
                if (path.parse(file).name === label) {
                    console.warn(`RisuAI: The sprite ${label} for ${name} already exists. Skipping.`);
                    continue outer;
                }
            }

            const filename = label + '.png';
            const pathToFile = path.join(spritesPath, sanitize(filename));
            writeFileAtomicSync(pathToFile, fileBase64, { encoding: 'base64' });
        }

        // Remove additionalAssets and emotions from data (they are now in the sprites folder)
        delete data.data.extensions.risuai.additionalAssets;
        delete data.data.extensions.risuai.emotions;
    } catch (error) {
        console.error(error);
    }
}

/**
 * Imports the lorebooks a Chub card links to and adds them to the character's additional books. Runs after the
 * character is written, so there is always a character to link them to.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} avatar The written character.
 * @param {any} card The character's card.
 * @returns {Promise<string[]>} The character's additional books after, or [] when none was imported.
 */
export async function importChubRelatedLorebooks(directories, avatar, card) {
    if (!isLinkedLorebookFetchAllowed(directories)) return [];
    /** @type {string[]} */
    const paths = (card?.data?.extensions?.chub?.related_lorebooks ?? []).map((/** @type {any} */ entry) => entry?.path).filter(Boolean);
    /** @type {string[]} */
    const names = [];
    for (const lorebookPath of paths) {
        try {
            const result = await downloadChubLorebook(lorebookPath);
            const name = result ? await importWorldInfoFromRaw(directories, result.fileName, result.buffer.toString('utf8')) : null;
            if (name !== null) names.push(name);
        } catch (error) {
            console.error(`Failed to import related Chub lorebook "${lorebookPath}"`, error);
        }
    }
    if (names.length === 0) return [];
    return (await (await userStore(directories)).lib.extraLinks(avatar, 'add', names)) ?? [];
}
