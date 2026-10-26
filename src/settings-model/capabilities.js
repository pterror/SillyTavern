import { TYPE } from '../library-codes.js';
import { draft } from './entity-draft.js';

/**
 * Capabilities (§1.4, step 3c): each a slot naming a connection from the one list, so captioning through llama.cpp is
 * the llama.cpp connection text generation uses, and an OpenAI voice the OpenAI connection. Made from the built-in
 * extensions' provider fields, which leave their settings (kept as JSON, Q8) and come back at the edge.
 *
 * - A provider that is a chat completion source or text completion backend names that family's connection type; one
 *   that runs in the browser a `browser:*` type; the server's own models (transformers.js) `transformers`; Extras
 *   `extras`. A provider with nothing to share names a type of its own, `<capability>:<provider>`, which a provider
 *   these tables don't know (an extension's) also gets, so it comes back as it came.
 * - Classification through the main API follows text generation (`FOLLOWS_TEXT_GENERATION`); none is `null`.
 * - Speech recognition has no provider field in this repo (no such built-in extension); its settings stay as they are.
 */

/** A capability's statement that it uses whatever text generation uses. */
export const FOLLOWS_TEXT_GENERATION = 'textGeneration';

const tc = name => `textgenerationwebui:${name}`;
const cc = name => `openai:${name}`;

/** Caption's multimodal APIs. */
const CAPTION_APIS = Object.freeze({
    aimlapi: cc('aimlapi'), chutes: cc('chutes'), anthropic: cc('claude'), workers_ai: cc('workers_ai'), cohere: cc('cohere'),
    custom: cc('custom'), electronhub: cc('electronhub'), google: cc('makersuite'), vertexai: cc('vertexai'), groq: cc('groq'),
    koboldcpp: tc('koboldcpp'), llamacpp: tc('llamacpp'), mistral: cc('mistralai'), moonshot: cc('moonshot'), nanogpt: cc('nanogpt'),
    ollama: tc('ollama'), openai: cc('openai'), openrouter: cc('openrouter'), ooba: tc('ooba'), pollinations: cc('pollinations'),
    vllm: tc('vllm'), xai: cc('xai'), zai: cc('zai'),
});

/** Caption's other sources. */
const CAPTION_SOURCES = Object.freeze({ local: 'transformers', extras: 'extras', horde: 'horde' });

/** Expressions' classification APIs (numbers). */
const CLASSIFICATION_APIS = Object.freeze({ 0: 'transformers', 1: 'extras', 2: FOLLOWS_TEXT_GENERATION, 3: 'browser:webllm', 99: null });

/** TTS providers that share another family's connection or run in the browser; any other is `tts:<name>`. */
const TTS_PROVIDERS = Object.freeze({
    'OpenAI': cc('openai'), 'Chutes': cc('chutes'), 'Electron Hub': cc('electronhub'), 'Pollinations': cc('pollinations'),
    'MiniMax': cc('minimax'), 'Novel': 'novel', 'SpeechT5': 'transformers', 'System': 'browser:speech-synthesis', 'Kokoro': 'browser:kokoro',
});

/** Image generation sources that share another family's connection; `google` by its `google_api`; any other `image:<source>`. */
const IMAGE_SOURCES = Object.freeze({
    extras: 'extras', horde: 'horde', novel: 'novel', openai: cc('openai'), aimlapi: cc('aimlapi'), togetherai: tc('togetherai'),
    pollinations: cc('pollinations'), chutes: cc('chutes'), electronhub: cc('electronhub'), nanogpt: cc('nanogpt'), xai: cc('xai'),
    zai: cc('zai'), openrouter: cc('openrouter'), workersai: cc('workers_ai'),
});
const IMAGE_GOOGLE_APIS = Object.freeze({ makersuite: cc('makersuite'), vertexai: cc('vertexai') });

/** Embedding sources; any other is `embeddings:<source>`. */
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

/**
 * Each capability: its extension's settings key, and how its provider fields give a connection type and back.
 * `from` reads the type and drops the fields it read from the settings copy; `to` writes them for a type.
 * @type {Readonly<Record<string, { extension: string, from: (s: Record<string, any>) => string | null | undefined, to: (s: Record<string, any>, type: string | null) => boolean }>>}
 */
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

/** The capability slots, besides text generation's (connections.js). */
export const CAPABILITY_SLOTS = Object.freeze(Object.keys(CAPABILITIES));

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {object} CapabilitiesFromUpstream
 * @property {Record<string, string | null>} capabilities Each slot's statement: a connection key,
 *   FOLLOWS_TEXT_GENERATION, or null for none.
 * @property {Record<string, Record<string, unknown>>} settings The extensions' settings without their provider fields.
 * @property {EntityDraft[]} connections The connections made for types no connection had.
 */

/**
 * @param {Record<string, any>} extensionSettings Upstream's `extension_settings`.
 * @param {EntityDraft[]} connections The connections there are.
 * @param {(hint: string) => string} newKey The key of what `hint` names; the same hint, the same key.
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
 * The extensions' settings with their provider fields, from the capabilities.
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
