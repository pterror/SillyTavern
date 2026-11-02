import { Buffer } from 'node:buffer';

import { CHAT_COMPLETION_SOURCES, MEDIA_EXTENSIONS } from './constants.js';
import { saveUserImageFile } from './endpoints/images.js';

const DATA_URL = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/is;

/**
 * @param {unknown} url
 * @returns {url is string}
 */
const isImageDataUrl = url => typeof url === 'string' && DATA_URL.test(url);

/**
 * @param {any} parts
 * @returns {string[]}
 */
function inlineDataUrls(parts) {
    if (!Array.isArray(parts)) return [];
    return parts.filter(x => x?.inlineData && !x.thought).map(x => `data:${x.inlineData.mimeType};base64,${x.inlineData.data}`).filter(isImageDataUrl);
}

/**
 * @param {any} images
 * @returns {string[]}
 */
function imageUrlsOf(images) {
    if (!Array.isArray(images)) return [];
    return images.filter(x => x?.type === 'image_url').map(x => x?.image_url?.url).filter(isImageDataUrl);
}

/**
 * @param {any} data
 * @param {{ mainApi?: string, source?: string | null }} settings
 * @returns {string[]}
 */
export function imagesOfAnswer(data, { mainApi, source }) {
    if (mainApi !== 'openai' || !data) return [];
    switch (source) {
        case CHAT_COMPLETION_SOURCES.VERTEXAI:
        case CHAT_COMPLETION_SOURCES.MAKERSUITE:
            return inlineDataUrls(data?.responseContent?.parts);
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return imageUrlsOf(data?.choices?.[0]?.message?.images);
        default:
            return [];
    }
}

/**
 * @param {object|null|undefined} pending
 * @param {any} json
 */
export function noteReplyImages(pending, json) {
    if (!pending) return;
    const found = [...inlineDataUrls(json?.candidates?.[0]?.content?.parts), ...imageUrlsOf(json?.choices?.[0]?.delta?.images)];
    if (!found.length) return;
    pending.replyImages ??= [];
    pending.replyImages.push(...found);
}

/**
 * @param {object} pending
 * @param {Record<string, unknown>} extra
 * @returns {Promise<void>}
 */
export async function storeReplyImages(pending, extra) {
    const urls = [...new Set([...(pending.replyImages ?? []), ...imagesOfAnswer(pending.answer?.data, pending.finish ?? {})])];
    if (!urls.length || !pending.directories) return;
    const kept = pending.isContinue ? pending.anchorContent?.extra?.media : extra.media;
    const media = Array.isArray(kept) ? [...kept] : [];
    const stamp = Date.now();
    for (const [index, url] of urls.entries()) {
        const [, subtype, base64] = /** @type {RegExpExecArray} */ (DATA_URL.exec(url));
        const format = subtype.toLowerCase();
        if (!MEDIA_EXTENSIONS.includes(format)) continue;
        const saved = await saveUserImageFile(pending.directories, pending.chat.store.lib, {
            buffer: Buffer.from(base64, 'base64'), format, subFolder: pending.name2, filename: `inline_image_${stamp}_${index}`,
        });
        media.push({ url: saved.path, type: 'image', source: 'api' });
    }
    if (media.length) {
        extra.media = media;
        extra.inline_image = true;
    }
}
