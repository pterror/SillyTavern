import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import fetch from 'node-fetch';
import mime from 'mime-types';
import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getImageBuffers } from '../util.js';
import { downloadChubLorebook, isLinkedLorebookFetchAllowed } from './content-manager.js';
import { importWorldInfoFromRaw } from './worldinfo.js';

/**
 * Gets the path to the sprites folder for the provided character name
 * @param {import('../users.js').UserDirectoryList} directories - User directories
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
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {object} data RisuAI character data
 * @param {string | null} [avatarFileName] The character's eventual avatar identity (id, no extension), once the
 * caller knows it. Runtime lookup (getSpriteFolderName() in public/scripts/extensions/expressions/index.js)
 * resolves sprite folders by avatar identity first, falling back to display name only when it has none - so
 * writing under the display name here whenever this is available would create a folder runtime can't find.
 * Falls back to the display name when not yet known (e.g. no caller has one to give).
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
 * @param {string} spritesPath
 * @param {string} label
 * @param {Record<string, unknown>} expressionsMap
 */
async function downloadChubExpressionPack(spritesPath, label, expressionsMap) {
    const existingLabels = new Set(fs.readdirSync(spritesPath).map(f => path.parse(f).name));

    const entries = Object.entries(expressionsMap)
        .filter(([, value]) => typeof value === 'string' && /^https?:\/\//.test(value));

    if (entries.length === 0) {
        return;
    }

    console.info(`Chub: Found ${entries.length} expression(s) for ${label}. Fetching in the background.`);

    for (const [emotion, url] of entries) {
        if (existingLabels.has(emotion)) {
            console.warn(`Chub: The sprite ${emotion} for ${label} already exists. Skipping.`);
            continue;
        }
        try {
            const result = await fetch(url);
            if (!result.ok) {
                console.warn(`Chub: Failed to download expression "${emotion}" for ${label}: HTTP ${result.status}`);
                continue;
            }
            const buffer = Buffer.from(await result.arrayBuffer());
            const sourceExt = path.extname(new URL(url).pathname) || '.png';
            const pathToFile = path.join(spritesPath, sanitize(`${emotion}${sourceExt}`));
            writeFileAtomicSync(pathToFile, buffer);
        } catch (error) {
            console.warn(`Chub: Failed to download expression "${emotion}" for ${label}:`, error.message);
        }
    }
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} name
 * @param {boolean} isSubfolder
 * @returns {string | null}
 */
function ensureSpritesPath(directories, name, isSubfolder) {
    const spritesPath = getSpritesPath(directories, name, isSubfolder);
    if (!spritesPath) {
        return null;
    }
    if (!fs.existsSync(spritesPath)) {
        fs.mkdirSync(spritesPath, { recursive: true });
    }
    if (!fs.statSync(spritesPath).isDirectory()) {
        return null;
    }
    return spritesPath;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} data
 * @param {string | null} [avatarFileName]
 * @returns {void}
 */
export function importChubExpressions(directories, data, avatarFileName = null) {
    try {
        const name = data?.data?.name;
        const chubExt = data?.data?.extensions?.chub;
        if (!name || !chubExt) {
            return;
        }

        const folderName = avatarFileName || name;

        /** @type {[string, string, Record<string, unknown>][]} */
        const jobs = [];

        const primaryExpressions = chubExt.expressions?.expressions;
        if (primaryExpressions && typeof primaryExpressions === 'object') {
            const spritesPath = ensureSpritesPath(directories, folderName, false);
            if (spritesPath) jobs.push([spritesPath, name, primaryExpressions]);
        }

        if (chubExt.alt_expressions && typeof chubExt.alt_expressions === 'object') {
            for (const [altKey, altPack] of Object.entries(chubExt.alt_expressions)) {
                const altExpressions = altPack?.expressions;
                if (!altExpressions || typeof altExpressions !== 'object') continue;
                const label = `${name}/${altKey}`;
                const spritesPath = ensureSpritesPath(directories, `${folderName}/${altKey}`, true);
                if (spritesPath) jobs.push([spritesPath, label, altExpressions]);
            }
        }

        if (jobs.length === 0) {
            return;
        }

        (async () => {
            for (const [spritesPath, label, expressionsMap] of jobs) {
                await downloadChubExpressionPack(spritesPath, label, expressionsMap);
            }
        })();
    } catch (error) {
        console.error(error);
    }
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} data
 * @returns {void}
 */
export function importChubRelatedLorebooks(directories, data) {
    try {
        if (!isLinkedLorebookFetchAllowed(directories)) {
            return;
        }

        const chubExt = data?.data?.extensions?.chub;
        if (!chubExt) {
            return;
        }

        /** @type {string[]} */
        const relatedLorebookPaths = (chubExt.related_lorebooks ?? [])
            .map(entry => entry?.path)
            .filter(Boolean);

        if (relatedLorebookPaths.length === 0) {
            return;
        }

        (async () => {
            for (const lorebookPath of relatedLorebookPaths) {
                try {
                    const result = await downloadChubLorebook(lorebookPath);
                    await importWorldInfoFromRaw(directories, result.fileName, result.buffer.toString('utf8'));
                } catch (error) {
                    console.error(`Failed to import related Chub lorebook "${lorebookPath}"`, error);
                }
            }
        })();
    } catch (error) {
        console.error(error);
    }
}

export const router = express.Router();

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} name
 * @returns {{ label: string, path: string }[]}
 */
export function spritesOf(directories, name) {
    const isSubfolder = name.includes('/');
    const spritesPath = getSpritesPath(directories, name, isSubfolder);
    let sprites = [];

    try {
        if (spritesPath && fs.existsSync(spritesPath) && fs.statSync(spritesPath).isDirectory()) {
            sprites = fs.readdirSync(spritesPath)
                .filter(file => {
                    const mimeType = mime.lookup(file);
                    return mimeType && mimeType.startsWith('image/');
                })
                .map((file) => {
                    const pathToSprite = path.join(spritesPath, file);
                    const mtime = fs.statSync(pathToSprite).mtime?.toISOString().replace(/[^0-9]/g, '').slice(0, 14);

                    const fileName = path.parse(pathToSprite).name.toLowerCase();
                    // Extract the label from the filename via regex, which can be suffixed with a sub-name, either connected with a dash or a dot.
                    // Examples: joy.png, joy-1.png, joy.expressive.png
                    const label = fileName.match(/^(.+?)(?:[-\\.].*?)?$/)?.[1] ?? fileName;

                    return {
                        label: label,
                        path: `/characters/${name}/${file}` + (mtime ? `?t=${mtime}` : ''),
                    };
                });
        }
    } catch (err) {
        console.error(err);
    }
    return sprites;
}

router.get('/get', function (request, response) {
    return response.send(spritesOf(request.user.directories, String(request.query.name)));
});

router.get('/folders', function (request, response) {
    const folders = [];
    try {
        const root = request.user.directories.characters;
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            folders.push(entry.name);
            const subRoot = path.join(root, entry.name);
            for (const subEntry of fs.readdirSync(subRoot, { withFileTypes: true })) {
                if (subEntry.isDirectory()) folders.push(`${entry.name}/${subEntry.name}`);
            }
        }
    } catch (err) {
        console.error(err);
    }
    return response.send(folders);
});

router.post('/rename-folder', (request, response) => {
    const oldName = String(request.body.oldName || '');
    const newName = String(request.body.newName || '');

    if (!oldName || !newName) {
        return response.sendStatus(400);
    }

    try {
        const oldPath = getSpritesPath(request.user.directories, oldName, oldName.includes('/'));
        const newPath = getSpritesPath(request.user.directories, newName, newName.includes('/'));

        if (!oldPath || !newPath) {
            return response.sendStatus(400);
        }
        if (!fs.existsSync(oldPath) || !fs.statSync(oldPath).isDirectory()) {
            return response.sendStatus(404);
        }
        if (fs.existsSync(newPath)) {
            return response.status(409).send('A folder already exists at the new name');
        }

        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/delete-folder', (request, response) => {
    const name = String(request.body.name || '');

    if (!name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, name.includes('/'));

        if (!spritesPath) {
            return response.sendStatus(400);
        }
        if (!fs.existsSync(spritesPath) || !fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        fs.rmSync(spritesPath, { recursive: true, force: true });
        return response.sendStatus(204);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/delete', async (request, response) => {
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!spriteName || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // No sprites folder exists, or not a directory
        if (!spritesPath || !fs.existsSync(spritesPath) || !fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = fs.readdirSync(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                fs.unlinkSync(path.join(spritesPath, file));
            }
        }

        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload-zip', async (request, response) => {
    const file = request.file;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');

    if (!file || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!fs.existsSync(spritesPath)) {
            fs.mkdirSync(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const spritePackPath = path.join(file.destination, file.filename);
        const sprites = await getImageBuffers(spritePackPath);
        const files = fs.readdirSync(spritesPath);

        for (const [filename, buffer] of sprites) {
            // Remove existing sprite with the same label
            const existingFile = files.find(file => path.parse(file).name === path.parse(filename).name);

            if (existingFile) {
                fs.unlinkSync(path.join(spritesPath, existingFile));
            }

            // Write sprite buffer to disk
            const pathToSprite = path.join(spritesPath, sanitize(filename));
            writeFileAtomicSync(pathToSprite, buffer);
        }

        // Remove uploaded ZIP file
        fs.unlinkSync(spritePackPath);
        return response.send({ ok: true, count: sprites.length });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    const file = request.file;
    const label = request.body.label;
    const name = String(request.body.name);
    const isSubfolder = name.includes('/');
    const spriteName = request.body.spriteName || label;

    if (!file || !label || !name) {
        return response.sendStatus(400);
    }

    try {
        const spritesPath = getSpritesPath(request.user.directories, name, isSubfolder);

        // Invalid sprites path
        if (!spritesPath) {
            return response.sendStatus(400);
        }

        // Create sprites folder if it doesn't exist
        if (!fs.existsSync(spritesPath)) {
            fs.mkdirSync(spritesPath, { recursive: true });
        }

        // Path to sprites is not a directory. This should never happen.
        if (!fs.statSync(spritesPath).isDirectory()) {
            return response.sendStatus(404);
        }

        const files = fs.readdirSync(spritesPath);

        // Remove existing sprite with the same label
        for (const file of files) {
            if (path.parse(file).name === spriteName) {
                fs.unlinkSync(path.join(spritesPath, file));
            }
        }

        const filename = spriteName + path.parse(file.originalname).ext;
        const spritePath = path.join(file.destination, file.filename);
        const pathToFile = path.join(spritesPath, sanitize(filename));
        // Copy uploaded file to sprites folder
        fs.cpSync(spritePath, pathToFile);
        // Remove uploaded file
        fs.unlinkSync(spritePath);
        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
