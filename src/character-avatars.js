import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_AVATAR_PATH } from './constants.js';
import { computeAvatarIdentityHashFromImageBuffer, stripCardData } from './character-card-parser.js';
import { TYPE } from './library-engine.js';

/**
 * Characters' images are `characters/<avatar>`, upstream's paths; the store holds each card's values and its image's
 * identity hash (the image without its card chunk), which recognises the same picture on import. Copies of one image
 * share their bytes through the filesystem (reflinks), not through the store.
 */

/** A character's image and its card are written in the avatar's lane, so two writes of one character don't interleave. */
const LANE = -1;

/**
 * @param {{ characters: string }} directories
 * @param {string} avatar
 */
export function avatarFile(directories, avatar) {
    return path.join(directories.characters, avatar);
}

/**
 * The image file a character shows: its file in `characters/`, the default avatar when it has none; null when there
 * is no such character.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {{ characters: string }} directories
 * @param {string} avatar
 * @returns {Promise<string | null>}
 */
export async function avatarPathOf(lib, directories, avatar) {
    const e = await lib.entity(TYPE.character, avatar);
    if (!e) return null;
    const file = avatarFile(directories, avatar);
    return fs.existsSync(file) ? file : DEFAULT_AVATAR_PATH;
}

/**
 * An image as a character's: its card chunk stripped (the store holds the card), and its identity hash.
 * @param {Buffer} image A PNG.
 * @returns {{ image: Buffer, avatarIdentityHash: string }}
 */
export function avatarImage(image) {
    const stripped = stripCardData(image);
    return { image: stripped, avatarIdentityHash: computeAvatarIdentityHashFromImageBuffer(stripped) };
}

/**
 * Stores a card with a new image, in the avatar's lane: the image written beside the character's file, `write` (which
 * stores the card), then the image put in place. When `write` fails the character keeps the image it had.
 * @template T
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {{ characters: string }} directories
 * @param {string} avatar
 * @param {ReturnType<typeof avatarImage>} image
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
export function writeWithAvatar(lib, directories, avatar, image, write) {
    return lib.serialized(LANE, avatar, async () => {
        const file = avatarFile(directories, avatar);
        const next = `${file}.next`;
        fs.mkdirSync(directories.characters, { recursive: true });
        writeFileAtomicSync(next, image.image);
        let result;
        try {
            result = await write();
        } catch (error) {
            fs.rmSync(next, { force: true });
            throw error;
        }
        fs.renameSync(next, file);
        return result;
    });
}

/**
 * Runs `write` in the avatar's lane.
 * @template T
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} avatar
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
export function inAvatarLane(lib, avatar, write) {
    return lib.serialized(LANE, avatar, write);
}
