import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import writeFileAtomic from 'write-file-atomic';

import { Jimp } from '../jimp.js';
import { getConfigValue, isPathUnderParent } from '../util.js';
import { userStore } from '../user-stores.js';
import { HASH, TYPE } from '../library-codes.js';
import { animatedHash, isAnimatedImage, stillHash, stillImage } from '../image-identity.js';
import { decodeFrames, encodeAnimatedWebp } from '../image-frames.js';
import { THUMBNAIL_QUALITY, parseThumbnailName } from '../thumbnail-urls.js';

export const router = express.Router();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const CANDIDATES = 8;
const KEEP_AFTER_EVICTION = 0.9;

/**
 * @returns {number}
 */
export function cacheBytes() {
    const megabytes = Number(getConfigValue('thumbnails.cacheSize', 256, 'number'));
    return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 256) * 1024 * 1024;
}

/** @type {Map<string, Promise<number>>} */
const cacheSizes = new Map();

/**
 * @param {string} dir
 * @returns {Promise<{ file: string, size: number, mtimeMs: number }[]>}
 */
async function cacheFiles(dir) {
    const names = await fs.promises.readdir(dir).catch(() => /** @type {string[]} */ ([]));
    const files = await Promise.all(names.map(async (name) => {
        const file = path.join(dir, name);
        const stat = await fs.promises.stat(file).catch(() => null);
        return stat?.isFile() ? { file, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }));
    return /** @type {{ file: string, size: number, mtimeMs: number }[]} */ (files.filter(Boolean));
}

/**
 * @param {string} dir
 * @param {number} added
 * @param {number} [limit]
 */
export async function accountCache(dir, added, limit = cacheBytes()) {
    const before = cacheSizes.get(dir) ?? cacheFiles(dir).then(files => files.reduce((sum, f) => sum + f.size, 0) - added);
    const next = before.then(async (size) => {
        const total = size + added;
        if (total <= limit) return total;
        const files = (await cacheFiles(dir)).sort((a, b) => a.mtimeMs - b.mtimeMs);
        let kept = files.reduce((sum, f) => sum + f.size, 0);
        for (const f of files) {
            if (kept <= limit * KEEP_AFTER_EVICTION) break;
            await fs.promises.rm(f.file, { force: true });
            kept -= f.size;
        }
        return kept;
    });
    cacheSizes.set(dir, next.catch(() => 0));
    return next;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {number} type
 * @param {string} key
 * @returns {string | null}
 */
function originalPath(directories, type, key) {
    if (type === TYPE.userImage) {
        const file = path.join(directories.root, key);
        return isPathUnderParent(directories.userImages, file) ? file : null;
    }
    if (sanitize(key) !== key) return null;
    if (type === TYPE.character) return path.join(directories.characters, key);
    if (type === TYPE.personaImage) return path.join(directories.avatars, key);
    if (type === TYPE.background) return path.join(directories.backgrounds, key);
    return null;
}

/**
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ hex: string, which: number }} wanted
 * @returns {Promise<{ buffer: Buffer, type: number, key: string } | null>}
 */
export async function originalOf(lib, directories, wanted) {
    const ids = await lib.store.libraryByHash(wanted.which, Buffer.from(wanted.hex, 'hex'), CANDIDATES);
    const keys = ids.length ? await lib.store.libraryKeys(ids) : [];
    for (const found of keys) {
        if (!found) continue;
        const file = originalPath(directories, found.type, found.key);
        if (file === null) continue;
        const buffer = await fs.promises.readFile(file).catch(() => null);
        if (buffer === null) continue;
        const hex = wanted.which === HASH.animated ? animatedHash(buffer) : stillHash(buffer);
        if (hex === wanted.hex) return { buffer, type: found.type, key: found.key };
    }
    return null;
}

/**
 * @param {InstanceType<typeof Jimp>} image
 * @param {import('../thumbnail-urls.js').ThumbnailSpec} spec
 * @param {import('../thumbnail-urls.js').Crop | null} crop
 */
function shape(image, spec, crop) {
    if (crop) {
        const { width, height } = image.bitmap;
        const x = Math.min(crop.x, width - 1);
        const y = Math.min(crop.y, height - 1);
        image.crop({ x, y, w: Math.max(1, Math.min(crop.width, width - x)), h: Math.max(1, Math.min(crop.height, height - y)) });
    }
    if (spec.cover) {
        image.cover({ w: spec.cover.w, h: spec.cover.h });
    } else if (spec.fit) {
        const { width, height } = image.bitmap;
        const scale = Math.min(1, spec.fit / Math.max(width, height));
        if (scale < 1) image.resize({ w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) });
    }
    return image;
}

/**
 * @param {Buffer} buffer
 * @param {import('../thumbnail-urls.js').ThumbnailSpec} spec
 * @param {{ crop?: import('../thumbnail-urls.js').Crop | null, animate?: boolean }} [options]
 * @returns {Promise<Buffer>}
 */
export async function renderThumbnail(buffer, spec, { crop = null, animate = false } = {}) {
    const decoded = isAnimatedImage(buffer) ? await decodeFrames(buffer) : null;
    if (decoded && animate) {
        const frames = decoded.frames.map(f => ({ image: shape(Jimp.fromBitmap({ data: Buffer.from(f.rgba), width: decoded.width, height: decoded.height }), spec, crop), delay: f.delay }));
        const { width, height } = frames[0].image.bitmap;
        return encodeAnimatedWebp({ width, height, frames: frames.map(f => ({ rgba: f.image.bitmap.data, delay: f.delay })) }, THUMBNAIL_QUALITY);
    }
    const image = decoded
        ? Jimp.fromBitmap({ data: Buffer.from(decoded.frames[0].rgba), width: decoded.width, height: decoded.height })
        : await Jimp.read(stillImage(buffer));
    shape(image, spec, crop);
    return Buffer.from(await image.getBuffer('image/webp', { quality: THUMBNAIL_QUALITY }));
}

router.get('/:name', async function (request, response) {
    try {
        const name = request.params.name;
        const wanted = parseThumbnailName(name);
        if (!wanted) return response.sendStatus(404);
        const directories = request.user.directories;
        const cached = path.join(directories.thumbnails, name);
        if (fs.existsSync(cached)) {
            const now = new Date();
            fs.promises.utimes(cached, now, now).catch(() => {});
            response.setHeader('Cache-Control', IMMUTABLE);
            return response.sendFile(name, { root: directories.thumbnails });
        }
        const { lib } = await userStore(directories);
        const original = await originalOf(lib, directories, wanted);
        if (!original) return response.sendStatus(404);
        const rendered = await renderThumbnail(original.buffer, wanted.spec, { crop: wanted.crop, animate: wanted.animate });
        await fs.promises.mkdir(directories.thumbnails, { recursive: true });
        await writeFileAtomic(cached, rendered);
        void accountCache(directories.thumbnails, rendered.length).catch(error => console.warn('[thumbnails] Evicting failed:', error));
        response.setHeader('Cache-Control', IMMUTABLE);
        response.setHeader('Content-Type', 'image/webp');
        return response.send(rendered);
    } catch (error) {
        console.error('[thumbnails] Failed to serve a thumbnail:', error);
        return response.sendStatus(500);
    }
});
