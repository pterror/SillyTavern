import { TYPE } from '../library-codes.js';
import { draft } from './entity-draft.js';

export const FOLLOWS_TEXT_GENERATION = 'textGeneration';

const tc = name => `textgenerationwebui:${name}`;
const cc = name => `openai:${name}`;

const CAPTION_APIS = Object.freeze({
    aimlapi: cc('aimlapi'), chutes: cc('chutes'), anthropic: cc('claude'), workers_ai: cc('workers_ai'), cohere: cc('cohere'),
    custom: cc('custom'), electronhub: cc('electronhub'), google: cc('makersuite'), vertexai: cc('vertexai'), groq: cc('groq'),
    koboldcpp: tc('koboldcpp'), llamacpp: tc('llamacpp'), mistral: cc('mistralai'), moonshot: cc('moonshot'), nanogpt: cc('nanogpt'),
    ollama: tc('ollama'), openai: cc('openai'), openrouter: cc('openrouter'), ooba: tc('ooba'), pollinations: cc('pollinations'),
    vllm: tc('vllm'), xai: cc('xai'), zai: cc('zai'),
});

const CAPTION_SOURCES = Object.freeze({ local: 'transformers', extras: 'extras', horde: 'horde' });

const CLASSIFICATION_APIS = Object.freeze({ 0: 'transformers', 1: 'extras', 2: FOLLOWS_TEXT_GENERATION, 3: 'browser:webllm', 99: null });

const TTS_PROVIDERS = Object.freeze({
    'OpenAI': cc('openai'), 'Chutes': cc('chutes'), 'Electron Hub': cc('electronhub'), 'Pollinations': cc('pollinations'),
    'MiniMax': cc('minimax'), 'Novel': 'novel', 'SpeechT5': 'transformers', 'System': 'browser:speech-synthesis', 'Kokoro': 'browser:kokoro',
});

const IMAGE_SOURCES = Object.freeze({
    extras: 'extras', horde: 'horde', novel: 'novel', openai: cc('openai'), aimlapi: cc('aimlapi'), togetherai: tc('togetherai'),
    pollinations: cc('pollinations'), chutes: cc('chutes'), electronhub: cc('electronhub'), nanogpt: cc('nanogpt'), xai: cc('xai'),
    zai: cc('zai'), openrouter: cc('openrouter'), workersai: cc('workers_ai'),
});
const IMAGE_GOOGLE_APIS = Object.freeze({ makersuite: cc('makersuite'), vertexai: cc('vertexai') });

const EMBEDDING_SOURCES = Object.freeze({
    chutes: cc('chutes'), workers_ai: cc('workers_ai'), cohere: cc('cohere'), electronhub: cc('electronhub'), extras: 'extras',
    palm: cc('makersuite'), vertexai: cc('vertexai'), koboldcpp: tc('koboldcpp'), llamacpp: tc('llamacpp'), transformers: 'transformers',
    mistral: cc('mistralai'), nanogpt: cc('nanogpt'), ollama: tc('ollama'), openai: cc('openai'), openrouter: cc('openrouter'),
    siliconflow: cc('siliconflow'), togetherai: tc('togetherai'), vllm: tc('vllm'), webllm: 'browser:webllm',
});

/**
 * @param {Readonly<Record<string, string | null>>} table
 * @param {string} prefix
 * @param {unknown} value
 * @returns {string | null}
 */
function typeIn(table, prefix, value) {
    return Object.hasOwn(table, String(value)) ? table[String(value)] : `${prefix}:${value}`;
}

/**
 * @param {Readonly<Record<string, string | null>>} table
 * @param {string} prefix
 * @param {string | null} type
 * @returns {string | undefined}
 */
function valueIn(table, prefix, type) {
    const known = Object.entries(table).find(([, t]) => t === type)?.[0];
    if (known !== undefined) return known;
    return type?.startsWith(`${prefix}:`) ? type.slice(prefix.length + 1) : undefined;
}

/** @type {Readonly<Record<string, { extension: string, from: (s: Record<string, any>) => string | null | undefined, to: (s: Record<string, any>, type: string | null) => boolean }>>} */
const CAPABILITIES = Object.freeze({
    captioning: {
        extension: 'caption',
        from(s) {
            if (!Object.hasOwn(s, 'source')) return undefined;
            const source = s.source;
            delete s.source;
            if (source !== 'multimodal') return typeIn(CAPTION_SOURCES, 'caption', source);
            const api = s.multimodal_api;
            delete s.multimodal_api;
            return typeIn(CAPTION_APIS, 'caption-multimodal', api);
        },
        to(s, type) {
            const source = valueIn(CAPTION_SOURCES, 'caption', type);
            if (source !== undefined) {
                s.source = source;
                return true;
            }
            const api = valueIn(CAPTION_APIS, 'caption-multimodal', type);
            if (api === undefined) return false;
            s.source = 'multimodal';
            s.multimodal_api = api;
            return true;
        },
    },
    classification: {
        extension: 'expressions',
        from(s) {
            if (!Object.hasOwn(s, 'api')) return undefined;
            const api = s.api;
            delete s.api;
            return typeIn(CLASSIFICATION_APIS, 'classification', api);
        },
        to(s, type) {
            const api = valueIn(CLASSIFICATION_APIS, 'classification', type);
            if (api === undefined) return false;
            s.api = Number.isNaN(Number(api)) ? api : Number(api);
            return true;
        },
    },
    tts: {
        extension: 'tts',
        from(s) {
            if (!Object.hasOwn(s, 'currentProvider')) return undefined;
            const provider = s.currentProvider;
            delete s.currentProvider;
            return typeIn(TTS_PROVIDERS, 'tts', provider);
        },
        to(s, type) {
            const provider = valueIn(TTS_PROVIDERS, 'tts', type);
            if (provider === undefined) return false;
            s.currentProvider = provider;
            return true;
        },
    },
    imageGeneration: {
        extension: 'sd',
        from(s) {
            if (!Object.hasOwn(s, 'source')) return undefined;
            const source = s.source;
            delete s.source;
            if (source !== 'google') return typeIn(IMAGE_SOURCES, 'image', source);
            const api = s.google_api;
            delete s.google_api;
            return typeIn(IMAGE_GOOGLE_APIS, 'image-google', api);
        },
        to(s, type) {
            const api = valueIn(IMAGE_GOOGLE_APIS, 'image-google', type);
            if (api !== undefined) {
                s.source = 'google';
                s.google_api = api;
                return true;
            }
            const source = valueIn(IMAGE_SOURCES, 'image', type);
            if (source === undefined) return false;
            s.source = source;
            return true;
        },
    },
    embeddings: {
        extension: 'vectors',
        from(s) {
            if (!Object.hasOwn(s, 'source')) return undefined;
            const source = s.source;
            delete s.source;
            return typeIn(EMBEDDING_SOURCES, 'embeddings', source);
        },
        to(s, type) {
            const source = valueIn(EMBEDDING_SOURCES, 'embeddings', type);
            if (source === undefined) return false;
            s.source = source;
            return true;
        },
    },
    translation: {
        extension: 'translate',
        from(s) {
            if (!Object.hasOwn(s, 'provider')) return undefined;
            const provider = s.provider;
            delete s.provider;
            return `translation:${provider}`;
        },
        to(s, type) {
            if (!type?.startsWith('translation:')) return false;
            s.provider = type.slice('translation:'.length);
            return true;
        },
    },
});

export const CAPABILITY_SLOTS = Object.freeze(Object.keys(CAPABILITIES));

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {object} CapabilitiesFromUpstream
 * @property {Record<string, string | null>} capabilities
 * @property {Record<string, Record<string, unknown>>} settings
 * @property {EntityDraft[]} connections
 */

/**
 * @param {Record<string, any>} extensionSettings
 * @param {EntityDraft[]} connections
 * @param {(hint: string) => string} newKey
 * @returns {CapabilitiesFromUpstream}
 */
export function capabilitiesFromUpstream(extensionSettings, connections, newKey) {
    /** @type {EntityDraft[]} */
    const made = [];
    /** @param {string} type */
    const connectionOf = (type) => {
        const found = [...connections, ...made].find(connection => connection.values.type === type);
        if (found) return found.key;
        const connection = draft(TYPE.connection, newKey(`connection ${type}`), { type });
        made.push(connection);
        return connection.key;
    };
    /** @type {Record<string, string | null>} */
    const capabilities = {};
    /** @type {Record<string, Record<string, unknown>>} */
    const settings = {};
    for (const [slot, capability] of Object.entries(CAPABILITIES)) {
        const own = extensionSettings?.[capability.extension];
        if (!own || typeof own !== 'object') continue;
        const copy = structuredClone(own);
        const type = capability.from(copy);
        settings[capability.extension] = copy;
        if (type === undefined) continue;
        capabilities[slot] = type === null || type === FOLLOWS_TEXT_GENERATION ? type : connectionOf(type);
    }
    return { capabilities, settings, connections: made };
}

/**
 * @param {Record<string, Record<string, unknown>>} settings
 * @param {Record<string, string | null>} capabilities
 * @param {EntityDraft[]} connections
 * @returns {{ settings: Record<string, Record<string, unknown>>, warnings: string[] }}
 */
export function capabilitiesToUpstream(settings, capabilities, connections) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {Record<string, Record<string, unknown>>} */
    const out = structuredClone(settings);
    for (const [slot, statement] of Object.entries(capabilities)) {
        const capability = CAPABILITIES[slot];
        if (!capability) continue;
        const type = statement === null || statement === FOLLOWS_TEXT_GENERATION
            ? statement
            : /** @type {string | undefined} */ (connections.find(connection => connection.key === statement)?.values.type);
        if (type === undefined) {
            warnings.push(`${slot} names a connection there isn't (${statement}); left out`);
            continue;
        }
        out[capability.extension] ??= {};
        if (!capability.to(out[capability.extension], type)) warnings.push(`${slot}: ${capability.extension} has no provider for ${type}; left out`);
    }
    return { settings: out, warnings };
}
