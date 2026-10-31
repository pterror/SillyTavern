import fs from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import mime from 'mime-types';
import { Jimp, JimpMime } from './jimp.js';
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
        this.counts = {
            'start_chat': 0,
            'prompt': 0,
            'bias': 0,
            'nudge': 0,
            'jailbreak': 0,
            'impersonate': 0,
            'examples': 0,
            'conversation': 0,
        };
    }

    getCounts() {
        return this.counts;
    }

    resetCounts() {
        Object.keys(this.counts).forEach((key) => this.counts[key] = 0);
    }

    setCounts(counts) {
        this.counts = counts;
    }

    uncount(value, type) {
        this.counts[type] -= value;
    }

    /**
     * @param {object|any[]} messages
     * @param {boolean} [full]
     * @param {string} [type]
     * @returns {Promise<number>}
     */
    async countAsync(messages, full, type) {
        const token_count = await this.countTokenAsyncFn(messages, full);
        this.counts[type] += token_count;

        return token_count;
    }

    getTokensForIdentifier(identifier) {
        return this.counts[identifier] ?? 0;
    }

    getTotal() {
        return Object.values(this.counts).reduce((a, b) => a + (isNaN(b) ? 0 : b), 0);
    }

    log() {
        console.table({ ...this.counts, 'total': this.getTotal() });
    }
}

export class IdentifierNotFoundError extends Error {
    constructor(identifier) {
        super(`Identifier ${identifier} not found.`);
        this.name = 'IdentifierNotFoundError';
    }
}

export class TokenBudgetExceededError extends Error {
    constructor(identifier = '') {
        super(`Token budged exceeded. Message: ${identifier}`);
        this.name = 'TokenBudgetExceeded';
    }
}

export class InvalidCharacterNameError extends Error {
    constructor(identifier = '') {
        super(`Invalid character name. Message: ${identifier}`);
        this.name = 'InvalidCharacterName';
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
     * @param {{role: string, content: string, identifier: string}} prompt
     * @param {TokenHandler} tokenHandler
     * @returns {Promise<Message>}
     */
    static fromPromptAsync(prompt, tokenHandler) {
        return Message.createAsync(prompt.role, prompt.content, prompt.identifier, tokenHandler);
    }

    /**
     * @returns {number}
     */
    getTokens() { return this.tokens; }

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

/**
 * @class
 */
export class MessageCollection {
    collection = [];
    identifier;

    /**
     * @constructor
     * @param {string} identifier
     * @param {...(Message|MessageCollection)} items
     */
    constructor(identifier, ...items) {
        for (let item of items) {
            if (!(item instanceof Message || item instanceof MessageCollection)) {
                throw new Error('Only Message and MessageCollection instances can be added to MessageCollection');
            }
        }

        this.collection.push(...items);
        this.identifier = identifier;
    }

    /**
     * @returns {Array}
     */
    getChat() {
        return this.collection.reduce((acc, message) => {
            if (message.content || message.tool_calls) {
                acc.push({
                    role: message.role,
                    content: message.content,
                    ...(message.name && { name: message.name }),
                    ...(message.tool_calls && { tool_calls: message.tool_calls }),
                    ...(message.role === 'tool' && { tool_call_id: message.identifier }),
                    ...(message.signature && { signature: message.signature }),
                    ...(message.reasoning && { reasoning: message.reasoning }),
                });
            }
            return acc;
        }, []);
    }

    /**
     * @returns {Array}
     */
    getCollection() {
        return this.collection;
    }

    /**
     * @param {Object} item
     */
    add(item) {
        this.collection.push(item);
    }

    /**
     * @param {string} identifier
     * @returns {Object}
     */
    getItemByIdentifier(identifier) {
        return this.collection.find(item => item?.identifier === identifier);
    }

    /**
     * @param {string} identifier
     * @returns {boolean}
     */
    hasItemWithIdentifier(identifier) {
        return this.collection.some(message => message.identifier === identifier);
    }

    /**
     * @returns {number}
     */
    getTokens() {
        return this.collection.reduce((tokens, message) => tokens + message.getTokens(), 0);
    }

    /**
     * @returns {Message[]}
     */
    flatten() {
        return this.collection.reduce((acc, message) => {
            if (message instanceof MessageCollection) {
                acc.push(...message.flatten());
            } else {
                acc.push(message);
            }
            return acc;
        }, []);
    }
}

export class ChatCompletion {
    /**
     * @param {TokenHandler} tokenHandler
     */
    constructor(tokenHandler) {
        this.tokenHandler = tokenHandler;
        this.tokenBudget = 0;
        this.messages = new MessageCollection('root');
        this.loggingEnabled = false;
        this.overriddenPrompts = [];
    }

    /**
     * @returns {Promise<void>}
     */
    async squashSystemMessages() {
        const excludeList = ['newMainChat', 'newChat', 'groupNudge'];
        this.messages.collection = this.messages.flatten();

        let lastMessage = null;
        let squashedMessages = [];

        for (let message of this.messages.collection) {
            if (message.role === 'system' && !message.content) {
                continue;
            }

            const shouldSquash = (message) => {
                return !excludeList.includes(message.identifier) && message.role === 'system' && !message.name;
            };

            if (shouldSquash(message)) {
                if (lastMessage && shouldSquash(lastMessage)) {
                    lastMessage.content += '\n' + message.content;
                    lastMessage.tokens = await this.tokenHandler.countAsync({ role: lastMessage.role, content: lastMessage.content });
                } else {
                    squashedMessages.push(message);
                    lastMessage = message;
                }
            } else {
                squashedMessages.push(message);
                lastMessage = message;
            }
        }

        this.messages.collection = squashedMessages;
    }

    /**
     * @returns {MessageCollection}
     */
    getMessages() {
        return this.messages;
    }

    /**
     * @param {number} context
     * @param {number} response
     */
    setTokenBudget(context, response) {
        this.log(`Prompt tokens: ${context}`);
        this.log(`Completion tokens: ${response}`);

        this.tokenBudget = context - response;

        this.log(`Token budget: ${this.tokenBudget}`);
    }

    /**
     * @param {Message|MessageCollection} collection
     * @param {number|null} [position]
     * @returns {ChatCompletion}
     */
    add(collection, position = null) {
        this.validateMessageCollection(collection);
        this.checkTokenBudget(collection, collection.identifier);

        if (null !== position && -1 !== position) {
            this.messages.collection[position] = collection;
        } else {
            this.messages.collection.push(collection);
        }

        this.decreaseTokenBudgetBy(collection.getTokens());

        this.log(`Added ${collection.identifier}. Remaining tokens: ${this.tokenBudget}`);

        return this;
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     */
    insertAtStart(message, identifier) {
        this.insert(message, identifier, 'start');
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     */
    insertAtEnd(message, identifier) {
        this.insert(message, identifier, 'end');
    }

    /**
     * @param {Message} message
     * @param {string} identifier
     * @param {string|number} [position]
     */
    insert(message, identifier, position = 'end') {
        this.validateMessage(message);
        this.checkTokenBudget(message, message.identifier);

        const index = this.findMessageIndex(identifier);
        if (message.content || message.tool_calls) {
            if ('start' === position) this.messages.collection[index].collection.unshift(message);
            else if ('end' === position) this.messages.collection[index].collection.push(message);
            else if (typeof position === 'number') this.messages.collection[index].collection.splice(position, 0, message);

            this.decreaseTokenBudgetBy(message.getTokens());

            this.log(`Inserted ${message.identifier} into ${identifier}. Remaining tokens: ${this.tokenBudget}`);
        }
    }

    /**
     * @param identifier
     */
    removeLastFrom(identifier) {
        const index = this.findMessageIndex(identifier);
        const message = this.messages.collection[index].collection.pop();

        if (!message) {
            this.log(`No message to remove from ${identifier}`);
            return;
        }

        this.increaseTokenBudgetBy(message.getTokens());

        this.log(`Removed ${message.identifier} from ${identifier}. Remaining tokens: ${this.tokenBudget}`);
    }

    /**
     * @param {Message|MessageCollection} message
     * @returns {boolean}
     */
    canAfford(message) {
        return 0 <= this.tokenBudget - message.getTokens();
    }

    /**
     * @param {Message[]} messages
     * @returns {boolean}
     */
    canAffordAll(messages) {
        return 0 <= this.tokenBudget - messages.reduce((total, message) => total + message.getTokens(), 0);
    }

    /**
     * @param {string} identifier
     * @returns {boolean}
     */
    has(identifier) {
        return this.messages.hasItemWithIdentifier(identifier);
    }

    /**
     * @returns {number}
     */
    getTotalTokenCount() {
        return this.messages.getTokens();
    }

    /**
     * @returns {Array}
     */
    getChat() {
        const chat = [];
        for (let item of this.messages.collection) {
            if (item instanceof MessageCollection) {
                chat.push(...item.getChat());
            } else if (item instanceof Message && (item.content || item.tool_calls)) {
                const message = {
                    role: item.role,
                    content: item.content,
                    ...(item.name ? { name: item.name } : {}),
                    ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                    ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                    ...(item.signature ? { signature: item.signature } : {}),
                    ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                };
                chat.push(message);
            } else {
                this.log(`Skipping invalid or empty message in collection: ${JSON.stringify(item)}`);
            }
        }
        return chat;
    }

    /**
     * @param {string} output
     */
    log(output) {
        if (this.loggingEnabled) console.log('[ChatCompletion] ' + output);
    }

    enableLogging() {
        this.loggingEnabled = true;
    }

    disableLogging() {
        this.loggingEnabled = false;
    }

    /**
     * @param {MessageCollection|Message} collection
     */
    validateMessageCollection(collection) {
        if (!(collection instanceof MessageCollection)) {
            console.log(collection);
            throw new Error('Argument must be an instance of MessageCollection');
        }
    }

    /**
     * @param {Message} message
     */
    validateMessage(message) {
        if (!(message instanceof Message)) {
            console.log(message);
            throw new Error('Argument must be an instance of Message');
        }
    }

    /**
     * @param {Message|MessageCollection} message
     * @param {string} identifier
     */
    checkTokenBudget(message, identifier) {
        if (!this.canAfford(message)) {
            throw new TokenBudgetExceededError(identifier);
        }
    }

    /**
     * @param {Message|MessageCollection|number} message
     */
    reserveBudget(message) {
        const tokens = typeof message === 'number' ? message : message.getTokens();
        this.decreaseTokenBudgetBy(tokens);
    }

    /**
     * @param {Message|MessageCollection} message
     */
    freeBudget(message) { this.increaseTokenBudgetBy(message.getTokens()); }

    /**
     * @param {number} tokens
     */
    increaseTokenBudgetBy(tokens) {
        this.tokenBudget += tokens;
    }

    /**
     * @param {number} tokens
     */
    decreaseTokenBudgetBy(tokens) {
        this.tokenBudget -= tokens;
    }

    /**
     * @param {string} identifier
     * @returns {number}
     */
    findMessageIndex(identifier) {
        const index = this.messages.collection.findIndex(item => item?.identifier === identifier);
        if (index < 0) {
            throw new IdentifierNotFoundError(identifier);
        }
        return index;
    }

    /**
     * @param {string[]} list
     */
    setOverriddenPrompts(list) {
        this.overriddenPrompts = list;
    }

    getOverriddenPrompts() {
        return this.overriddenPrompts ?? [];
    }
}
