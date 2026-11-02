import fs from 'node:fs';
import path from 'node:path';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { DEFAULT_AVATAR_PATH } from './constants.js';
import { copyCharacterFile } from './local-import-copy.js';
import extract from 'png-chunks-extract';
import { computeAnimatedHashFromChunks, computeAvatarIdentityHashFromChunks, stripCardData } from './character-card-parser.js';
import { TYPE } from './library-engine.js';

const LANE = -1;

/**
 * @param {{ characters: string }} directories
 * @param {string} avatar
 */
export function avatarFile(directories, avatar) {
    return path.join(directories.characters, avatar);
}

/**
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
 * @param {Buffer} image
 * @returns {{ image: Buffer, avatarIdentityHash: string, animatedHash: string | null }}
 */
export function avatarImage(image) {
    const stripped = stripCardData(image);
    const chunks = extract(new Uint8Array(stripped));
    return { image: stripped, avatarIdentityHash: computeAvatarIdentityHashFromChunks(chunks), animatedHash: computeAnimatedHashFromChunks(chunks) };
}

/**
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
 * @template T
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} avatar
 * @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
export function inAvatarLane(lib, avatar, write) {
    return lib.serialized(LANE, avatar, write);
}
