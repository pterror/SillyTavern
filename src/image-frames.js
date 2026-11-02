import omggif from 'omggif';
import UPNG from 'upng-js';
import WebP from 'node-webpmux';

/**
 * @typedef {{ rgba: Uint8Array, delay: number }} Frame
 * @typedef {{ width: number, height: number, frames: Frame[] }} Frames
 */

const DEFAULT_DELAY = 100;

let webpReady = /** @type {Promise<void> | null} */ (null);
const webp = () => (webpReady ??= WebP.Image.initLib());

/**
 * @param {Buffer} buffer
 * @returns {'png' | 'gif' | 'webp' | null}
 */
function formatOf(buffer) {
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'png';
    const head = buffer.subarray(0, 12).toString('latin1');
    if (head.startsWith('GIF8')) return 'gif';
    if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
    return null;
}

/**
 * @param {Uint8Array} canvas
 * @param {number} width
 * @param {{ x: number, y: number, width: number, height: number }} rect
 */
function clearRect(canvas, width, rect) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
        canvas.fill(0, (y * width + rect.x) * 4, (y * width + rect.x + rect.width) * 4);
    }
}

/**
 * @param {Buffer} buffer
 * @returns {Frames}
 */
function apngFrames(buffer) {
    const image = UPNG.decode(buffer);
    const rgba = UPNG.toRGBA8(image);
    return {
        width: image.width,
        height: image.height,
        frames: rgba.map((frame, i) => ({ rgba: new Uint8Array(frame), delay: image.frames[i]?.delay || DEFAULT_DELAY })),
    };
}

/**
 * @param {Buffer} buffer
 * @returns {Frames}
 */
function gifFrames(buffer) {
    const reader = new omggif.GifReader(new Uint8Array(buffer));
    const { width, height } = reader;
    const canvas = new Uint8Array(width * height * 4);
    /** @type {Frame[]} */
    const frames = [];
    for (let i = 0; i < reader.numFrames(); i++) {
        const info = reader.frameInfo(i);
        const before = info.disposal === 3 ? canvas.slice() : null;
        reader.decodeAndBlitFrameRGBA(i, canvas);
        frames.push({ rgba: canvas.slice(), delay: info.delay ? info.delay * 10 : DEFAULT_DELAY });
        if (info.disposal === 2) clearRect(canvas, width, info);
        else if (before) canvas.set(before);
    }
    return { width, height, frames };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<Frames>}
 */
async function webpFrames(buffer) {
    await webp();
    const image = new WebP.Image();
    await image.load(buffer);
    const { width, height } = image;
    if (!image.hasAnim) return { width, height, frames: [{ rgba: new Uint8Array(await image.getImageData()), delay: 0 }] };
    const canvas = new Uint8Array(width * height * 4);
    /** @type {Frame[]} */
    const frames = [];
    for (let i = 0; i < image.frames.length; i++) {
        const frame = image.frames[i];
        const pixels = await image.getFrameData(i);
        for (let y = 0; y < frame.height; y++) {
            for (let x = 0; x < frame.width; x++) {
                const from = (y * frame.width + x) * 4;
                const to = ((frame.y + y) * width + frame.x + x) * 4;
                const alpha = pixels[from + 3] / 255;
                if (!frame.blend || alpha === 1) {
                    canvas.set(pixels.subarray(from, from + 4), to);
                } else if (alpha > 0) {
                    const under = canvas[to + 3] / 255;
                    const out = alpha + under * (1 - alpha);
                    for (let c = 0; c < 3; c++) {
                        canvas[to + c] = Math.round((pixels[from + c] * alpha + canvas[to + c] * under * (1 - alpha)) / out);
                    }
                    canvas[to + 3] = Math.round(out * 255);
                }
            }
        }
        frames.push({ rgba: canvas.slice(), delay: frame.delay || DEFAULT_DELAY });
        if (frame.dispose) clearRect(canvas, width, frame);
    }
    return { width, height, frames };
}

/**
 * @param {Buffer} buffer
 * @returns {Promise<Frames | null>}
 */
export async function decodeFrames(buffer) {
    const format = formatOf(buffer);
    /** @type {Frames | null} */
    let decoded = null;
    if (format === 'png') decoded = apngFrames(buffer);
    else if (format === 'gif') decoded = gifFrames(buffer);
    else if (format === 'webp') decoded = await webpFrames(buffer);
    return decoded && decoded.frames.length > 1 ? decoded : null;
}

/**
 * @param {Frames} decoded
 * @param {number} quality
 * @returns {Promise<Buffer>}
 */
export async function encodeAnimatedWebp({ width, height, frames }, quality) {
    await webp();
    const encoded = [];
    for (const frame of frames) {
        const image = await WebP.Image.getEmptyImage();
        await image.setImageData(Buffer.from(frame.rgba.buffer, frame.rgba.byteOffset, frame.rgba.byteLength), { width, height, quality });
        encoded.push(await WebP.Image.generateFrame({ img: image, delay: frame.delay, blend: false, dispose: false }));
    }
    return WebP.Image.save(null, { width, height, frames: encoded, loops: 0, bgColor: [0, 0, 0, 0] });
}

/**
 * @param {Frames} decoded
 * @returns {Buffer}
 */
export function encodeApng({ width, height, frames }) {
    return Buffer.from(UPNG.encode(frames.map(f => f.rgba.slice().buffer), width, height, 0, frames.map(f => f.delay)));
}
