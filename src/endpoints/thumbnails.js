import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import writeFileAtomic from 'write-file-atomic';

import { Jimp } from '../jimp.js';
import { getConfigValue } from '../util.js';
import { userStore } from '../user-stores.js';
import { HASH, TYPE } from '../library-codes.js';
import { stripCardData } from '../character-card-parser.js';
import { animatedHash, isPng, stillHash, stillImage } from '../image-identity.js';
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
    if (sanitize(key) !== key) return null;
    if (type === TYPE.character) return path.join(directories.characters, key);
    if (type === TYPE.personaImage) return path.join(directories.avatars, key);
    if (type === TYPE.background) return path.join(directories.backgrounds, key);
    return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} name
 */
function contentType(buffer, name) {
    if (isPng(buffer)) return 'image/png';
    const head = buffer.subarray(0, 12).toString('latin1');
    if (head.startsWith('GIF8')) return 'image/gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
    const extension = path.extname(name).toLowerCase();
    return extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
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
 * @param {Buffer} buffer
 * @param {import('../thumbnail-urls.js').ThumbnailSpec} spec
 * @returns {Promise<Buffer>}
 */
export async function renderThumbnail(buffer, spec) {
    const image = await Jimp.read(stillImage(buffer));
    if (spec.cover) {
        image.cover({ w: spec.cover.w, h: spec.cover.h });
    } else if (spec.fit) {
        const { width, height } = image.bitmap;
        const scale = Math.min(1, spec.fit / Math.max(width, height));
        if (scale < 1) image.resize({ w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) });
    }
    return Buffer.from(await image.getBuffer('image/webp', { quality: THUMBNAIL_QUALITY }));
}

router.get('/:name', async function (request, response) {
    try {
        const name = request.params.name;
        const wanted = parseThumbnailName(name);
        if (!wanted) return response.sendStatus(404);
        const directories = request.user.directories;
        const cached = path.join(directories.thumbnails, name);
        if (wanted.spec !== null && fs.existsSync(cached)) {
            const now = new Date();
            fs.promises.utimes(cached, now, now).catch(() => {});
            response.setHeader('Cache-Control', IMMUTABLE);
            return response.sendFile(name, { root: directories.thumbnails });
        }
        const { lib } = await userStore(directories);
        const original = await originalOf(lib, directories, wanted);
        if (!original) return response.sendStatus(404);
        if (wanted.spec === null) {
            const bytes = original.type === TYPE.character ? stripCardData(original.buffer) : original.buffer;
            response.setHeader('Cache-Control', IMMUTABLE);
            response.setHeader('Content-Type', contentType(bytes, original.key));
            return response.send(bytes);
        }
        let rendered;
        try {
            rendered = await renderThumbnail(original.buffer, wanted.spec);
        } catch (error) {
            console.warn(`[thumbnails] ${original.key} doesn't decode to a still; its original is shown:`, error.message);
            const bytes = original.type === TYPE.character ? stripCardData(original.buffer) : original.buffer;
            response.setHeader('Cache-Control', IMMUTABLE);
            response.setHeader('Content-Type', contentType(bytes, original.key));
            return response.send(bytes);
        }
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
