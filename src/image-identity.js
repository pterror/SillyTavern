import crypto from 'node:crypto';
import extract from 'png-chunks-extract';
import encode from './png/encode.js';
import { imageSize } from 'image-size';

import { Jimp } from './jimp.js';
import { computeAvatarIdentityHashFromChunks } from './character-card-parser.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FRAME_CHUNKS = new Set(['acTL', 'fcTL', 'IDAT', 'fdAT']);

/**
 * @param {Buffer} buffer
 */
export function isPng(buffer) {
    return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, data: Uint8Array }>}
 */
function pngChunks(buffer) {
    return extract(new Uint8Array(buffer));
}

/**
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
export function stillImage(buffer) {
    if (!isPng(buffer)) return buffer;
    const chunks = pngChunks(buffer);
    if (!chunks.some(c => c.name === 'acTL')) return buffer;
    return Buffer.from(encode(chunks.filter(c => c.name !== 'acTL' && c.name !== 'fcTL' && c.name !== 'fdAT')));
}

/**
 * @param {Buffer} buffer
 */
export function isAnimatedWebP(buffer) {
    const head = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;
    return head.includes('ANIM') || head.includes('ANMF');
}

/**
 * @param {Buffer} buffer
 */
function isGif(buffer) {
    return buffer.subarray(0, 4).toString('latin1') === 'GIF8';
}

/**
 * @param {Buffer} buffer
 */
function isWebP(buffer) {
    return buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP';
}

/**
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isAnimatedImage(buffer) {
    if (isPng(buffer)) return pngChunks(buffer).some(c => c.name === 'acTL');
    if (isGif(buffer)) return true;
    if (isWebP(buffer)) return isAnimatedWebP(buffer);
    return false;
}

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
export function stillHash(buffer) {
    if (isPng(buffer)) return computeAvatarIdentityHashFromChunks(pngChunks(buffer));
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {Buffer} buffer
 * @returns {string | null}
 */
export function animatedHash(buffer) {
    if (isPng(buffer)) {
        const chunks = pngChunks(buffer);
        if (!chunks.some(c => c.name === 'acTL')) return null;
        const hash = crypto.createHash('sha256');
        for (const chunk of chunks) {
            if (!FRAME_CHUNKS.has(chunk.name)) continue;
            hash.update(chunk.name);
            hash.update(chunk.data);
        }
        return hash.digest('hex');
    }
    if (!isAnimatedImage(buffer)) return null;
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function averageColor(buffer) {
    try {
        const image = await Jimp.read(buffer);
        image.resize({ w: 1, h: 1 });
        const color = image.getPixelColor(0, 0);
        const hex = (/** @type {number} */ c) => c.toString(16).padStart(2, '0');
        return `#${hex((color >> 24) & 255)}${hex((color >> 16) & 255)}${hex((color >> 8) & 255)}`;
    } catch {
        return '#808080';
    }
}

/**
 * @typedef {object} ImageFacts
 * @property {string} still
 * @property {string | null} animated
 * @property {number | null} aspect
 * @property {string} color
 */

/**
 * @param {Buffer} buffer
 * @param {{ color?: boolean }} [options]
 * @returns {Promise<ImageFacts>}
 */
export async function imageFacts(buffer, { color = true } = {}) {
    const animated = animatedHash(buffer);
    let aspect = null;
    try {
        const size = imageSize(buffer);
        if (size.width && size.height) aspect = Number((size.width / size.height).toFixed(4));
    } catch {
        aspect = null;
    }
    return { still: stillHash(buffer), animated, aspect, color: !color || animated ? '#808080' : await averageColor(buffer) };
}
