import fs from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import mime from 'mime-types';
import { Jimp, JimpMime } from '../jimp.js';
import { ResizeStrategy } from '@jimp/plugin-resize';

/**
 * @callback CountTokenAsyncFn
 * @param {object[]|object} messages
 * @param {boolean} [full]
 * @returns {Promise<number>}
 */

export class TokenHandler {
    /**
     * @param {CountTokenAsyncFn} countTokenAsyncFn
     */
    constructor(countTokenAsyncFn) {
        this.countTokenAsyncFn = countTokenAsyncFn;
    }

    /**
     * @param {object|any[]} messages
     * @param {boolean} [full]
     * @returns {Promise<number>}
     */
    countAsync(messages, full) {
        return this.countTokenAsyncFn(messages, full);
    }
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function isDataURL(str) {
    const regex = /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)*;?)?(base64)?,([a-z0-9!$&',()*+;=\-_%.~:@/?#]+)?$/i;
    return typeof str === 'string' && regex.test(str);
}

/**
 * @typedef {object} AttachmentDirectories
 * @property {string} userImages
 */

/**
 * @param {string} inputPath
 * @param {AttachmentDirectories} [directories]
 * @returns {string|null}
 */
function resolveLocalImagePath(inputPath, directories) {
    if (!directories?.userImages) {
        return null;
    }
    let relativePath = inputPath.replace(/^\/+/, '');
    const knownPrefix = 'user/images/';
    if (relativePath.startsWith(knownPrefix)) {
        relativePath = relativePath.slice(knownPrefix.length);
    }
    const resolvedRoot = path.resolve(directories.userImages);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
        return null;
    }
    return resolvedPath;
}

/**
 * @param {string} input
 * @param {{directories?: AttachmentDirectories}} [options]
 * @returns {Promise<string|null>}
 */
async function resolveAttachmentDataUrl(input, { directories } = {}) {
    if (isDataURL(input)) {
        return input;
    }
    if (/^https?:\/\//i.test(input)) {
        try {
            const response = await fetch(input, { method: 'GET' });
            if (!response.ok) {
                throw new Error(`Failed to fetch attachment: ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const mimeType = response.headers.get('content-type')?.split(';')[0] || mime.lookup(input) || 'application/octet-stream';
            return `data:${mimeType};base64,${buffer.toString('base64')}`;
        } catch (error) {
            console.error('Attachment adding skipped (fetch failed)', error);
            return null;
        }
    }
    try {
        const resolvedPath = resolveLocalImagePath(input, directories);
        if (!resolvedPath) {
            console.error(`Attachment adding skipped: could not resolve local path (input=${input})`);
            return null;
        }
        const buffer = await fs.readFile(resolvedPath);
        const mimeType = mime.lookup(resolvedPath) || 'application/octet-stream';
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
    } catch (error) {
        console.error('Attachment adding skipped (local read failed)', error);
        return null;
    }
}

export class Message {
    /** @type {number} */
    static tokensPerImage = 85;

    /** @type {number} */
    tokens;
    /** @type {string} */
    identifier;
    /** @type {string} */
    role;
    /** @type {string|any[]} */
    content;
    /** @type {string} */
    name;
    /** @type {object[]} */
    tool_calls;
    /** @type {string?} */
    signature = null;
    /** @type {string?} */
    reasoning = null;

    /**
     * @constructor
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @private
     */
    constructor(role, content, identifier) {
        this.identifier = identifier;
        this.role = role;
        this.content = content;

        if (!this.role) {
            console.log(`Message role not set, defaulting to 'system' for identifier '${this.identifier}'`);
            this.role = 'system';
        }

        this.tokens = 0;
    }

    /**
     * @param {string} role
     * @param {string} content
     * @param {string} identifier
     * @param {TokenHandler} tokenHandler
     * @returns {Promise<Message>}
     */
    static async createAsync(role, content, identifier, tokenHandler) {
        const message = new Message(role, content, identifier);

        if (typeof message.content === 'string' && message.content.length > 0) {
            message.tokens = await tokenHandler.countAsync({ role: message.role, content: message.content });
        }

        return message;
    }

    /**
     * @param {{id: string, name: string, parameters: any, signature?: string, reasoning?: string}[]} invocations
     * @param {boolean} includeSignature
     * @param {boolean} [includeReasoning]
     * @param {TokenHandler} tokenHandler
     * @returns {Promise<void>}
     */
    async setToolCalls(invocations, includeSignature, includeReasoning = false, tokenHandler) {
        this.tool_calls = invocations.map(i => ({
            id: i.id,
            type: 'function',
            function: {
                arguments: i.parameters,
                name: i.name,
            },
            ...(includeSignature && i.signature ? { signature: i.signature } : {}),
        }));
        const fallbackReasoning = invocations.find(i => typeof i.reasoning === 'string' && i.reasoning.length > 0)?.reasoning || null;
        this.reasoning = includeReasoning ? fallbackReasoning : null;
        this.tokens = await tokenHandler.countAsync({
            role: this.role,
            tool_calls: JSON.stringify(this.tool_calls),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        });
    }

    /**
     * @param {string} name
     * @param {TokenHandler} tokenHandler
     * @returns {Promise<void>}
     */
    async setName(name, tokenHandler) {
        this.name = name;
        this.tokens = await tokenHandler.countAsync({ role: this.role, content: this.content, name: this.name });
    }

    /**
     * @returns {any[]}
     */
    ensureContentIsArray() {
        const textContent = this.content;
        if (!Array.isArray(this.content)) {
            this.content = [];
            if (typeof textContent === 'string') {
                this.content.push({ type: 'text', text: textContent });
            }
        }
        return this.content;
    }

    /**
     * @returns {number}
     */
    getTokens() { return this.tokens; }

    /**
     * The message as the request carries it.
     * @returns {Record<string, any>}
     */
    toWire() {
        return {
            role: this.role,
            content: this.content,
            ...(this.name ? { name: this.name } : {}),
            ...(this.tool_calls ? { tool_calls: this.tool_calls } : {}),
            ...(this.role === 'tool' ? { tool_call_id: this.identifier } : {}),
            ...(this.signature ? { signature: this.signature } : {}),
            ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        };
    }

    /**
     * @param {string} image
     * @param {object} [options]
     * @param {string} [options.quality]
     * @param {string} [options.chatCompletionSource]
     * @param {{userImages?: string}} [options.directories]
     * @returns {Promise<void>}
     */
    async addImage(image, { quality = 'auto', chatCompletionSource, directories } = {}) {
        this.content = this.ensureContentIsArray();
        const resolved = await resolveAttachmentDataUrl(image, { directories });
        if (!resolved) {
            return;
        }
        image = await this.compressImage(resolved, { chatCompletionSource });
        this.content.push({ type: 'image_url', image_url: { 'url': image, 'detail': quality } });
        try {
            const tokens = await this.getImageTokenCost(image, quality);
            this.tokens += tokens;
        } catch (error) {
            this.tokens += Message.tokensPerImage;
            console.error('Failed to get image token cost', error);
        }
    }

    /**
     * @param {string} video
     * @param {object} [options]
     * @param {string} [options.quality]
     * @param {{userImages?: string}} [options.directories]
     * @returns {Promise<void>}
     */
    async addVideo(video, { quality = 'auto', directories } = {}) {
        this.content = this.ensureContentIsArray();
        const resolved = await resolveAttachmentDataUrl(video, { directories });
        if (!resolved) {
            return;
        }
        this.content.push({ type: 'video_url', video_url: { 'url': resolved, 'detail': quality } });
        this.tokens += 263 * 40;
    }

    /**
     * @param {string} audio
     * @param {{directories?: {userImages?: string}}} [options]
     * @returns {Promise<void>}
     */
    async addAudio(audio, { directories } = {}) {
        this.content = this.ensureContentIsArray();
        const resolved = await resolveAttachmentDataUrl(audio, { directories });
        if (!resolved) {
            return;
        }
        this.content.push({ type: 'audio_url', audio_url: { 'url': resolved } });
        this.tokens += 32 * 300;
    }

    /**
     * @param {string} image
     * @param {object} [options]
     * @param {string} [options.chatCompletionSource]
     * @returns {Promise<string>}
     */
    async compressImage(image, { chatCompletionSource } = {}) {
        const compressImageSources = ['openrouter', 'makersuite', 'mistralai', 'vertexai'];
        const sizeThreshold = 2 * 1024 * 1024;
        const dataSize = image.length * 0.75;
        const safeMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
        const mimeType = image?.split(';')?.[0]?.split(':')?.[1];
        if (compressImageSources.includes(chatCompletionSource) && dataSize > sizeThreshold) {
            const maxSide = 2048;
            image = await createThumbnail(image, maxSide, maxSide);
        } else if (!safeMimeTypes.includes(mimeType)) {
            image = await createThumbnail(image, null, null);
        }
        return image;
    }

    /**
     * @param {string} dataUrl
     * @param {string} quality
     * @returns {Promise<number>}
     */
    async getImageTokenCost(dataUrl, quality) {
        if (quality === 'low') {
            return Message.tokensPerImage;
        }
        const base64 = dataUrl.split(',')[1] ?? '';
        const buffer = Buffer.from(base64, 'base64');
        const size = imageSize(buffer);
        if (quality === 'auto' && size.width <= 512 && size.height <= 512) {
            return Message.tokensPerImage;
        }
        const scale = 2048 / Math.min(size.width, size.height);
        const scaledWidth = Math.round(size.width * scale);
        const scaledHeight = Math.round(size.height * scale);
        const finalScale = 768 / Math.min(scaledWidth, scaledHeight);
        const finalWidth = Math.round(scaledWidth * finalScale);
        const finalHeight = Math.round(scaledHeight * finalScale);
        const squares = Math.ceil(finalWidth / 512) * Math.ceil(finalHeight / 512);
        const tokens = squares * 170 + 85;
        return tokens;
    }
}

/**
 * @param {string} dataUrl
 * @param {number|null} maxWidth
 * @param {number|null} maxHeight
 * @returns {Promise<string>}
 */
async function createThumbnail(dataUrl, maxWidth, maxHeight) {
    const base64 = dataUrl.split(',')[1] ?? '';
    const buffer = Buffer.from(base64, 'base64');
    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;

    const aspectRatio = width / height;
    let thumbnailWidth = maxWidth;
    let thumbnailHeight = maxHeight;
    let effectiveMaxWidth = maxWidth;
    let effectiveMaxHeight = maxHeight;
    if (effectiveMaxWidth === null) {
        thumbnailWidth = width;
        effectiveMaxWidth = width;
    }
    if (effectiveMaxHeight === null) {
        thumbnailHeight = height;
        effectiveMaxHeight = height;
    }
    if (width <= effectiveMaxWidth && height <= effectiveMaxHeight) {
        thumbnailWidth = width;
        thumbnailHeight = height;
    } else if (width > height) {
        thumbnailHeight = effectiveMaxWidth / aspectRatio;
    } else {
        thumbnailWidth = effectiveMaxHeight * aspectRatio;
    }
    thumbnailWidth = Math.round(thumbnailWidth);
    thumbnailHeight = Math.round(thumbnailHeight);

    image.resize({ w: thumbnailWidth, h: thumbnailHeight, mode: ResizeStrategy.BILINEAR });
    const outputBuffer = await image.getBuffer(JimpMime.jpeg, { quality: 92, jpegColorSpace: 'ycbcr' });
    return `data:image/jpeg;base64,${outputBuffer.toString('base64')}`;
}
