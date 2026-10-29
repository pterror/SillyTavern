import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_AVATAR_PATH } from './constants.js';
import { copyCharacterFile } from './local-import-copy.js';
import { computeAvatarIdentityHashFromImageBuffer, stripCardData } from './character-card-parser.js';
import { TYPE } from './library-engine.js';

/**
 * Characters' images are `characters/<avatar>`, upstream's paths; the store holds each card's values and its image's
 * identity hash (the image without its card chunk), which recognises the same picture on import. Copies of one image
 * share their bytes through the filesystem (reflinks), not through the store.
 *
 * A card imported from a PNG file the server can read (a local import source, an upload, a file dropped into
 * `characters/`) keeps that file's bytes as they are: its image is a reflink of the file (a full copy only where the
 * filesystem can't reflink; never a hardlink, `copyCharacterFile()`), so an import costs no image write. The bytes
 * may still hold the card's text chunks (`chara`, `ccv3`) as the source had them; nothing reads them: the store is
 * the only source of a card's data. Everything that leaves the server leaves without them: the image route streams
 * the file without its text chunks (`stripPngText()`), and an exported card is written fresh from the store
 * (`materializeCardPng()`). An image the server makes or changes itself (a crop, a card format's embedded image, the
 * default avatar) is written as before, its card chunk stripped (`writeWithAvatar()`). Every write is a new file
 * renamed into place, never a change to a file in place.
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
 * Stores a card with an image taken from a PNG file, in the avatar's lane: the file reflinked beside the character's
 * file (copied where it can't be), `write` (which stores the card), then put in place; a file that already is the
 * character's file (dropped into `characters/`) stays as it is. When `write` fails the character keeps the image it
 * had. With `unchanged`, the source must still have that size and mtime once linked (the bytes the caller read and
 * hashed), else nothing is stored and `null` answered: a source rewritten since is imported again when it's seen.
 * @template T
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {{ characters: string }} directories
 * @param {string} avatar
 * @param {string} source
 * @param {() => Promise<T>} write
 * @param {{ size: number, mtimeMs: number }} [unchanged]
 * @returns {Promise<T | null>}
 */
export function linkWithAvatar(lib, directories, avatar, source, write, unchanged) {
    return lib.serialized(LANE, avatar, async () => {
        const file = avatarFile(directories, avatar);
        if (path.resolve(source) === path.resolve(file)) return await write();
        const next = `${file}.next`;
        fs.mkdirSync(directories.characters, { recursive: true });
        fs.rmSync(next, { force: true });
        await copyCharacterFile(source, next, null, { hardlink: false });
        let result;
        try {
            if (unchanged) {
                const now = fs.statSync(source);
                if (now.size !== unchanged.size || now.mtimeMs !== unchanged.mtimeMs) {
                    fs.rmSync(next, { force: true });
                    return null;
                }
            }
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
