import { TYPE } from './library-engine.js';
import { importedChatBookmarks } from './upstream-import.js';
import { promptParts } from './prompt-itemization.js';

const NAMED_CAP = 20;

/**
 * @typedef {object} UpstreamItemizationResult
 * @property {string} chat_id
 * @property {'stored' | 'not-found' | 'ambiguous'} status
 * @property {number} stored
 * @property {number} unchanged
 * @property {{ entry: number, mesId: unknown, why: string }[]} unmatched
 * @property {string} [why]
 */

/**
 * @typedef {object} UpstreamCounter
 * @property {(text: string) => Promise<number>} count
 * @property {() => object|null} tokenizer
 */

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} root
 * @param {{ chat_id: string, entries: Record<string, unknown>[] }[]} chats
 * @param {UpstreamCounter} counter
 * @returns {Promise<UpstreamItemizationResult[]>}
 */
export async function importUpstreamItemizations(store, root, chats, counter) {
    const mapped = importedChatBookmarks(root);
    /** @type {UpstreamItemizationResult[]} */
    const out = [];
    for (const { chat_id: chatId, entries } of chats) {
        const base = { chat_id: chatId, stored: 0, unchanged: 0, unmatched: [] };
        const found = await chatOf(store, mapped, chatId);
        if ('why' in found) {
            out.push({ ...base, status: found.status, why: found.why });
            continue;
        }
        const converted = await Promise.all(entries.map(entry => fromUpstream(entry, counter)));
        const done = await store.chats.importItemizations({ tree: found.tree, at: found.at, entries: converted });
        if (done === null) {
            out.push({ ...base, status: 'not-found', why: 'its chat\'s messages are gone' });
            continue;
        }
        out.push({ ...base, status: 'stored', ...done });
    }
    return out;
}

/**
 * @param {string} entry
 * @returns {bigint | null}
 */
function importedBookmarkOf(entry) {
    const m = /^b(0|[1-9][0-9]*)$/.exec(entry);
    return m ? BigInt(m[1]) : null;
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {Map<string, string[]>} mapped
 * @param {string} chatId
 * @returns {Promise<{ tree: bigint, at: string | null } | { status: 'not-found' | 'ambiguous', why: string }>}
 */
async function chatOf(store, mapped, chatId) {
    const { chats } = store;
    const bookmarks = mapped.get(chatId) ?? [];
    if (bookmarks.length > 1) return { status: 'ambiguous', why: `${bookmarks.length} imported chat files are named "${chatId}"` };
    /** @type {{ tree: bigint, bookmark: bigint }[]} */
    let candidates = [];
    if (bookmarks.length === 1) {
        const id = importedBookmarkOf(bookmarks[0]);
        const [b] = id === null ? [] : await chats.store.chatRead('bookmarks', { ids: [id] });
        const tree = !b ? null : b.at === null ? b.root : (await chats.stored([b.at])).get(b.at)?.owner ?? null;
        if (id === null || tree === null) return { status: 'not-found', why: `the chat imported from "${chatId}" is gone` };
        candidates = [{ tree, bookmark: id }];
    } else {
        candidates = await labelled(store, chatId);
        if (candidates.length > 1) return { status: 'ambiguous', why: `${candidates.length} chats are named "${chatId}"` };
        if (!candidates.length) return { status: 'not-found', why: `no chat is named "${chatId}"` };
    }
    const [{ tree, bookmark }] = candidates;
    const [b] = await chats.store.chatRead('bookmarks', { ids: [bookmark] });
    if (!b) return { status: 'not-found', why: `the chat named "${chatId}" is gone` };
    return { tree, at: b.at === null ? null : (await chats.externalIds([b.at]))[0] };
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} chatId
 * @returns {Promise<{ tree: bigint, bookmark: bigint }[]>}
 */
async function labelled(store, chatId) {
    const names = new Set();
    for (let at = chatId.indexOf(' - '); at > 0; at = chatId.indexOf(' - ', at + 1)) names.add(chatId.slice(0, at));
    /** @type {Map<bigint, bigint[]>} */
    const found = new Map();
    for (const name of names) {
        const rows = await store.lib.store.chatRead('libraryNamed', { type: TYPE.character, name, limit: NAMED_CAP });
        if (!rows.length) continue;
        const keys = (await store.lib.store.libraryKeys(rows.map((/** @type {any} */ r) => r.id))).filter(Boolean);
        const trees = await store.people.trees(keys.map((/** @type {any} */ k) => ({ avatar: k.key })));
        for (const tree of trees) {
            if (tree === null || tree === undefined || found.has(tree)) continue;
            found.set(tree, await store.lib.store.chatRead('bookmarksNamed', { tree, name: chatId }));
        }
    }
    return [...found].flatMap(([tree, ids]) => ids.map(bookmark => ({ tree, bookmark: BigInt(bookmark) })));
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOf(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * @param {Record<string, any>} entry
 * @param {UpstreamCounter} counter
 * @returns {Promise<Record<string, any>>}
 */
export async function fromUpstream(entry, counter) {
    const count = (/** @type {string} */ key) => {
        const text = textOf(entry?.[key]);
        return text ? counter.count(text) : Promise.resolve(0);
    };
    const keys = [
        'charDescription', 'charPersonality', 'scenarioText', 'userPersona', 'worldInfoString', 'allAnchors',
        'summarizeString', 'authorsNoteString', 'smartContextString', 'chatVectorsString', 'dataBankVectorsString',
        'beforeScenarioAnchor', 'afterScenarioAnchor', 'storyString', 'examplesString', 'mesSendString', 'instruction', 'promptBias',
    ];
    const counted = Object.fromEntries(await Promise.all(keys.map(async key => [key, await count(key)])));
    const anchors = counted.beforeScenarioAnchor + counted.afterScenarioAnchor;
    let total;
    /** @type {[import('./prompt-itemization.js').PromptPartName, number][]} */
    let inOrder;
    if (entry?.main_api === 'openai') {
        const named = counted.summarizeString + counted.authorsNoteString + counted.smartContextString + counted.chatVectorsString + counted.dataBankVectorsString;
        inOrder = [
            ['main', numberOf(entry.oaiMainTokens)], ['world_info', counted.worldInfoString], ['persona', counted.userPersona],
            ['description', counted.charDescription], ['personality', counted.charPersonality], ['scenario', counted.scenarioText],
            ['other_prompts', Math.max(0, numberOf(entry.oaiPromptTokens) - anchors - counted.charDescription - counted.charPersonality - counted.scenarioText)],
            ['auxiliary', numberOf(entry.oaiNsfwTokens)], ['examples', numberOf(entry.oaiExamplesTokens)], ['chat_start', numberOf(entry.oaiStartTokens)],
            ['chat_history', numberOf(entry.oaiConversationTokens)], ['post_history', numberOf(entry.oaiJailbreakTokens)],
            ['nudge', numberOf(entry.oaiNudgeTokens)], ['impersonate', numberOf(entry.oaiImpersonateTokens)],
            ['summary', counted.summarizeString], ['authors_note', counted.authorsNoteString], ['smart_context', counted.smartContextString],
            ['chat_vectors', counted.chatVectorsString], ['data_bank_vectors', counted.dataBankVectorsString],
            ['extensions', Math.max(0, counted.allAnchors - named)], ['bias', numberOf(entry.oaiBiasTokens)],
        ];
        total = numberOf(entry.oaiTotalTokens) || inOrder.reduce((sum, [, tokens]) => sum + tokens, 0);
    } else {
        const prompt = textOf(entry?.finalPrompt) || textOf(entry?.rawPrompt);
        const inStory = counted.worldInfoString + counted.charDescription + counted.charPersonality + counted.scenarioText
            + counted.userPersona + counted.instruction + anchors;
        const injections = Math.max(0, counted.allAnchors - anchors);
        inOrder = [
            ['story_string', Math.max(0, counted.storyString - inStory)], ['system_prompt', counted.instruction],
            ['world_info', counted.worldInfoString], ['description', counted.charDescription], ['personality', counted.charPersonality],
            ['scenario', counted.scenarioText], ['persona', counted.userPersona], ['extensions', anchors],
            ['examples', counted.examplesString], ['chat_history', Math.max(0, counted.mesSendString - injections)],
            ['injections', injections], ['bias', counted.promptBias],
        ];
        total = prompt ? await counter.count(prompt) : 0;
    }
    /** @type {Record<string, unknown>} */
    let samplerConfig = {};
    try {
        const parsed = JSON.parse(textOf(entry?.samplerConfigJson) || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) samplerConfig = parsed;
    } catch {
        samplerConfig = {};
    }
    return {
        ...(entry && 'mesId' in entry ? { mesId: entry.mesId } : {}),
        api: textOf(entry?.main_api),
        preset: textOf(entry?.presetName) || null,
        sampler_config: samplerConfig,
        tokenizer: counter.tokenizer(),
        max_context: numberOf(entry?.this_max_context),
        padding: numberOf(entry?.padding),
        rawPrompt: Array.isArray(entry?.rawPrompt) || typeof entry?.rawPrompt === 'string' ? entry.rawPrompt : '',
        messages_count: numberOf(entry?.messagesCount),
        examples_count: numberOf(entry?.examplesCount),
        total,
        parts: promptParts(inOrder),
    };
}
