import { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } from './constants.js';
import { substituteParams } from './macro-substitution.js';
import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { readSettingsAtPaths } from './settings-store.js';

/**
 * The finished form of a generated reply: what the server stores and sends the page. The page's own reasoning code
 * (public/scripts/reasoning.js) only displays it.
 *
 * Matches what upstream's page stores for a reply (saveReply(), ReasoningHandler, and the MESSAGE_RECEIVED auto-parse
 * in upstream public/scripts/reasoning.js):
 * - `extra.reasoning` is always a string ('' when there is none), `extra.reasoning_duration` a number of ms or null,
 *   `extra.reasoning_signature` the signature or null.
 * - Reasoning the backend sends apart from the text (native reasoning) is kept as is: `reasoning_type` 'model' when
 *   streamed, no type when not (as upstream's saveReply() stores it).
 * - With auto-parse on, a reasoning block at the start of the text (the user's prefix ... suffix) is moved out of
 *   `mes` into `extra.reasoning`, type 'parsed'. A streamed reply that starts with the prefix but never closes it
 *   is all reasoning, as upstream's streaming parse leaves it.
 * - Reasoning passes through the REASONING regex scripts.
 * - A new reply starts with the user's "Start Reply With" (`user_prompt_bias`), as upstream's cleanUpMessage() adds it.
 */

/** Mirrors public/scripts/reasoning.js ReasoningType. */
export const ReasoningType = {
    Model: 'model',
    Parsed: 'parsed',
};

/** Zero-width space: the legacy "no reasoning" placeholder (PromptReasoning.REASONING_PLACEHOLDER). */
const REASONING_PLACEHOLDER = '​';

/** Models that think without sending the reasoning back (public/scripts/reasoning.js isHiddenReasoningModel()). */
const HIDDEN_REASONING_MODELS = ['gpt-4.5', 'o1', 'o3', 'gemini-2.0-flash-thinking-exp', 'gemini-2.0-pro-exp'];

/**
 * @typedef {object} ReplyFinishSettings What finishing a reply needs from the user's settings, read when the
 * generation starts.
 * @property {string} mainApi 'openai' | 'textgenerationwebui' | 'kobold' | 'koboldhorde' | 'novel'
 * @property {string|null} source The chat completion source (openai) or text completion type (textgenerationwebui).
 * @property {boolean} showThoughts `oai_settings.show_thoughts`: chat completion reasoning is kept only when on.
 * @property {boolean} hiddenReasoningModel The model thinks without sending its reasoning.
 * @property {boolean} autoParse `power_user.reasoning.auto_parse`
 * @property {string} prefix `power_user.reasoning.prefix`, as typed (the parse matches it literally, as upstream's does)
 * @property {string} suffix `power_user.reasoning.suffix`
 * @property {string} promptPrefix The prefix with macros substituted, as it is put in a prompt.
 * @property {boolean} trimSpaces `power_user.trim_spaces`
 * @property {string} replyBias `power_user.user_prompt_bias` with macros substituted.
 * @property {object[]} regexScripts The regex scripts that apply (global, the character's if allowed, the preset's if allowed).
 * @property {boolean} regexEnabled The regex extension isn't disabled.
 * @property {{name1: string, name2: string}} macroContext
 */

/** Settings key and selected-preset field of each API's preset (public/scripts/preset-manager.js getPresetList()). */
const PRESET_SETTINGS = {
    openai: { key: 'oai_settings', name: 'preset_settings_openai' },
    textgenerationwebui: { key: 'textgenerationwebui_settings', name: 'preset' },
    kobold: { key: 'kai_settings', name: 'preset_settings' },
    koboldhorde: { key: 'kai_settings', name: 'preset_settings' },
    novel: { key: 'nai_settings', name: 'preset_settings_novel' },
};

/**
 * Reads what finishing a reply needs from the user's settings. Server-side port of the regex extension's
 * getRegexScripts({ allowedOnly: true }) (public/scripts/extensions/regex/engine.js) for the scripts.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} params.mainApi
 * @param {string|null} [params.source]
 * @param {string|null} [params.model]
 * @param {string|null} [params.avatar] The responding character's avatar.
 * @param {string} [params.name1]
 * @param {string} [params.name2]
 * @returns {Promise<ReplyFinishSettings>}
 */
export async function readReplyFinishSettings(directories, { mainApi, source = null, model = null, avatar = null, name1 = '', name2 = '' }) {
    const preset = PRESET_SETTINGS[mainApi];
    const paths = ['power_user', 'extension_settings', 'oai_settings.show_thoughts'];
    if (preset) paths.push(`${preset.key}.${preset.name}`, `${preset.key}.extensions`);
    /** @type {any} */
    const settings = readSettingsAtPaths(directories, paths);
    const powerUser = settings.power_user ?? {};
    const reasoning = powerUser.reasoning ?? {};
    const extensionSettings = settings.extension_settings ?? {};
    const macroContext = { name1, name2 };

    const regexEnabled = !(Array.isArray(extensionSettings.disabledExtensions) && extensionSettings.disabledExtensions.includes('regex'));
    const regexScripts = [];
    if (regexEnabled) {
        if (Array.isArray(extensionSettings.regex)) regexScripts.push(...extensionSettings.regex);
        if (avatar && Array.isArray(extensionSettings.character_allowed_regex) && extensionSettings.character_allowed_regex.includes(avatar)) {
            try {
                // Imported when needed: the characters endpoint needs the server's config loaded.
                const { readCardContent } = await import('./endpoints/characters.js');
                const raw = await readCardContent(directories, avatar);
                const scoped = raw === undefined ? null : JSON.parse(raw)?.data?.extensions?.regex_scripts;
                if (Array.isArray(scoped)) regexScripts.push(...scoped);
            } catch (error) {
                console.warn('Could not read the character\'s regex scripts:', error);
            }
        }
        if (preset) {
            const presetSettings = settings[preset.key] ?? {};
            const presetName = presetSettings[preset.name];
            const allowed = extensionSettings.preset_allowed_regex?.[mainApi === 'koboldhorde' ? 'kobold' : mainApi];
            const presetScripts = presetSettings.extensions?.regex_scripts;
            if (Array.isArray(allowed) && allowed.includes(presetName) && Array.isArray(presetScripts)) regexScripts.push(...presetScripts);
        }
    }

    const prefix = typeof reasoning.prefix === 'string' ? reasoning.prefix : '<think>';
    const userPromptBias = typeof powerUser.user_prompt_bias === 'string' ? powerUser.user_prompt_bias : '';
    return {
        mainApi,
        source,
        showThoughts: settings.oai_settings?.show_thoughts !== false,
        hiddenReasoningModel: mainApi === 'openai' && typeof model === 'string' && HIDDEN_REASONING_MODELS.some(name => model.startsWith(name)),
        autoParse: Boolean(reasoning.auto_parse),
        prefix,
        suffix: typeof reasoning.suffix === 'string' ? reasoning.suffix : '</think>',
        promptPrefix: substituteParams(prefix, macroContext),
        trimSpaces: powerUser.trim_spaces !== false,
        replyBias: userPromptBias.length ? substituteParams(userPromptBias, macroContext) : '',
        regexScripts,
        regexEnabled,
        macroContext,
    };
}

/**
 * The reasoning a non-streamed answer carries apart from its text. Server-side port of
 * extractReasoningFromData() (public/scripts/reasoning.js), reading the answer the page is sent.
 * @param {any} data
 * @param {ReplyFinishSettings} settings
 * @returns {string}
 */
export function extractReasoningFromData(data, { mainApi, source, showThoughts }) {
    switch (mainApi) {
        case 'textgenerationwebui':
            switch (source) {
                case TEXTGEN_TYPES.OPENROUTER:
                    return data?.choices?.[0]?.reasoning ?? '';
                case TEXTGEN_TYPES.OLLAMA:
                    return data?.thinking ?? '';
            }
            break;
        case 'openai':
            if (!showThoughts) break;
            switch (source) {
                case CHAT_COMPLETION_SOURCES.DEEPSEEK:
                case CHAT_COMPLETION_SOURCES.XAI:
                    return data?.choices?.[0]?.message?.reasoning_content ?? '';
                case CHAT_COMPLETION_SOURCES.OPENROUTER:
                    return data?.choices?.[0]?.message?.reasoning ?? data?.choices?.[0]?.message?.reasoning_content ?? '';
                case CHAT_COMPLETION_SOURCES.MAKERSUITE:
                case CHAT_COMPLETION_SOURCES.VERTEXAI:
                    return data?.responseContent?.parts?.filter(part => part.thought)?.map(part => part.text)?.join('\n\n') ?? '';
                case CHAT_COMPLETION_SOURCES.CLAUDE:
                    return data?.content?.filter(part => part.type === 'thinking')?.map(part => part.thinking)?.join('\n\n') ?? '';
                case CHAT_COMPLETION_SOURCES.MISTRALAI:
                    return data?.choices?.[0]?.message?.content?.[0]?.thinking?.map(part => part.text)?.filter(x => x)?.join('\n\n') ?? '';
                case CHAT_COMPLETION_SOURCES.AIMLAPI:
                case CHAT_COMPLETION_SOURCES.POLLINATIONS:
                case CHAT_COMPLETION_SOURCES.MOONSHOT:
                case CHAT_COMPLETION_SOURCES.COMETAPI:
                case CHAT_COMPLETION_SOURCES.CHUTES:
                case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
                case CHAT_COMPLETION_SOURCES.NANOGPT:
                case CHAT_COMPLETION_SOURCES.SILICONFLOW:
                case CHAT_COMPLETION_SOURCES.ZAI:
                case CHAT_COMPLETION_SOURCES.WORKERS_AI:
                case CHAT_COMPLETION_SOURCES.FIREWORKS:
                case CHAT_COMPLETION_SOURCES.CUSTOM:
                    return data?.choices?.[0]?.message?.reasoning_content ?? data?.choices?.[0]?.message?.reasoning ?? '';
            }
            break;
    }
    return '';
}

/**
 * The reasoning signature of a non-streamed answer. Server-side port of extractReasoningSignatureFromData()
 * (public/scripts/reasoning.js), which only finds one in OpenRouter's `reasoning_details`.
 * @param {any} data
 * @param {ReplyFinishSettings} settings
 * @returns {string|null}
 */
export function extractReasoningSignatureFromData(data, { mainApi, source }) {
    if (mainApi !== 'openai' || source !== CHAT_COMPLETION_SOURCES.OPENROUTER) return null;
    const details = data?.choices?.[0]?.message?.reasoning_details;
    if (!Array.isArray(details)) return null;
    for (const detail of details) {
        if (!/^tool_/.test(detail?.id) && detail?.type === 'reasoning.encrypted' && detail.data) return detail.data;
    }
    return null;
}

/** @param {string} string */
function escapeRegex(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * @param {string} text
 * @param {boolean} trimSpaces
 */
function trimIf(text, trimSpaces) {
    return trimSpaces ? text.trim() : text;
}

/**
 * Splits a reasoning block off the start of a text, as upstream's page does: `streamed`, the streaming parse (the
 * text starts with the prefix exactly; with no suffix yet, everything is reasoning); otherwise
 * parseReasoningFromString() (whitespace may come first; a block that isn't closed isn't one).
 * @param {string} text
 * @param {{prefix: string, suffix: string, trimSpaces: boolean}} settings
 * @param {boolean} streamed
 * @returns {{reasoning: string, content: string}|null} null when there's no block.
 */
export function splitReasoningBlock(text, { prefix, suffix, trimSpaces }, streamed) {
    if (!prefix || !suffix || typeof text !== 'string') return null;
    if (streamed && text.startsWith(prefix) && text.length > prefix.length) {
        const rest = text.slice(prefix.length);
        const end = rest.indexOf(suffix);
        if (end < 0) return { reasoning: trimIf(rest, trimSpaces), content: '' };
        return { reasoning: trimIf(rest.slice(0, end), trimSpaces), content: trimIf(rest.slice(end + suffix.length), trimSpaces) };
    }
    const regex = new RegExp(`^\\s*?${escapeRegex(prefix)}(.*?)${escapeRegex(suffix)}`, 's');
    let reasoning = null;
    const content = text.replace(regex, (_match, captured) => {
        reasoning = captured;
        return '';
    });
    if (reasoning === null) return null;
    return { reasoning: trimIf(reasoning, trimSpaces), content: trimIf(content, trimSpaces) };
}

/**
 * @typedef {object} ReplyStream What a streamed reply's pipe noted while it streamed.
 * @property {string} reasoning The reasoning the backend sent apart from the text.
 * @property {number|null} reasoningEndedAt When the text after the reasoning started.
 * @property {string|null} signature
 * @property {boolean} parseOff The text doesn't start with the reasoning prefix, so no block is being streamed.
 * @property {number} suffixFrom Where the search for the reasoning suffix resumes.
 */

/**
 * For a stream: notes a piece of reasoning the backend sent apart from the text. Chat completion reasoning counts
 * only with "show thoughts" on, as the page counts it.
 * @param {object|null|undefined} pending The generation's `pendingAssistantPersist`.
 * @param {string} text
 */
export function noteReplyReasoning(pending, text) {
    if (!pending || !text) return;
    const settings = pending.finish;
    if (settings?.mainApi === 'openai' && !settings.showThoughts) return;
    const stream = replyStreamOf(pending);
    stream.reasoning += text;
}

/**
 * For a stream: notes the text so far, so the reasoning's duration ends when the text after it starts, as upstream's
 * streaming reasoning measures it. Called with every piece of text; cheap once the reasoning has ended.
 * @param {object|null|undefined} pending
 * @param {string} text The whole text so far.
 */
export function noteReplyText(pending, text) {
    if (!pending) return;
    const stream = replyStreamOf(pending);
    if (stream.reasoningEndedAt !== null || !text) return;
    const settings = pending.finish;
    if (stream.reasoning || settings?.hiddenReasoningModel) {
        stream.reasoningEndedAt = Date.now();
        return;
    }
    if (!settings?.autoParse || !settings.prefix || !settings.suffix || stream.parseOff) return;
    // Each piece searches only past what was searched before, so a long reasoning block costs its length once.
    const { prefix, suffix } = settings;
    const target = parseTarget(pending, text);
    if (target.length <= prefix.length) return;
    if (!target.startsWith(prefix)) {
        // The streaming parse never starts on this reply.
        stream.parseOff = true;
        return;
    }
    const end = target.indexOf(suffix, Math.max(prefix.length, stream.suffixFrom));
    if (end < 0) {
        stream.suffixFrom = Math.max(prefix.length, target.length - suffix.length + 1);
        return;
    }
    if (trimIf(target.slice(end + suffix.length), settings.trimSpaces)) stream.reasoningEndedAt = Date.now();
}

/** @returns {ReplyStream} */
function replyStreamOf(pending) {
    pending.replyStream ??= { reasoning: '', reasoningEndedAt: null, signature: null, parseOff: false, suffixFrom: 0 };
    return pending.replyStream;
}

/**
 * The reply's whole text before its reasoning is split off: the "Start Reply With" text and the generated text for a
 * new reply; for a continue, the reasoning being continued (when the prompt ended inside it), the message's text and
 * the generated text.
 * @param {object} pending
 * @param {string} generatedText
 */
function parseTarget(pending, generatedText) {
    const settings = pending.finish;
    if (!pending.isContinue) return (settings?.replyBias ?? '') + generatedText;
    const anchor = pending.anchorContent ?? {};
    const oldText = typeof anchor.mes === 'string' ? anchor.mes : '';
    return continuedReasoningPrefix(pending) + oldText + generatedText;
}

/**
 * For a continue of a message with reasoning and no text yet: the prompt ended inside its reasoning block
 * (PromptReasoning's `prefixIncomplete`), so the reply continues the reasoning.
 * @param {object} pending
 * @returns {string}
 */
function continuedReasoningPrefix(pending) {
    const settings = pending.finish;
    const anchor = pending.anchorContent ?? {};
    const reasoning = typeof anchor.extra?.reasoning === 'string' ? anchor.extra.reasoning : '';
    if (!settings?.autoParse || !settings.prefix || !settings.suffix || anchor.mes || !reasoning || reasoning === REASONING_PLACEHOLDER) return '';
    return settings.promptPrefix + reasoning;
}

/**
 * @param {string} reasoning
 * @param {ReplyFinishSettings} settings
 */
function regexed(reasoning, settings) {
    return getRegexedString(reasoning, regex_placement.REASONING, settings.regexScripts, {
        regexExtensionEnabled: settings.regexEnabled, macroContext: settings.macroContext,
    });
}

/**
 * The reply as it is stored: its text and the reasoning fields of its `extra`.
 * @param {object} pending The generation's `pendingAssistantPersist` (with `finish`, and `replyStream` for a stream).
 * @param {string} generatedText The text the backend generated.
 * @param {{data?: any}} [answer] A non-streamed answer, as sent to the page, to read native reasoning from.
 * @returns {{mes: string, extra: {reasoning: string, reasoning_duration: number|null, reasoning_signature: string|null, reasoning_type?: string}}}
 */
export function finishReply(pending, generatedText, answer = {}) {
    /** @type {ReplyFinishSettings} */
    const settings = pending.finish ?? {
        mainApi: '', source: null, showThoughts: false, hiddenReasoningModel: false, autoParse: false, prefix: '', suffix: '', promptPrefix: '',
        trimSpaces: false, replyBias: '', regexScripts: [], regexEnabled: false, macroContext: { name1: '', name2: '' },
    };
    const stream = pending.replyStream ?? null;
    const streamed = stream !== null;
    const anchorExtra = pending.isContinue ? (pending.anchorContent?.extra ?? {}) : {};
    const startedAt = pending.generationStop?.startedAt;
    const endedAt = stream?.reasoningEndedAt ?? Date.now();
    const measured = streamed && Number.isFinite(startedAt) ? Math.max(0, endedAt - startedAt) : null;

    let native = streamed ? stream.reasoning : (answer.data !== undefined ? extractReasoningFromData(answer.data, settings) : '');
    native = typeof native === 'string' ? native : '';
    const signature = streamed ? stream.signature : (answer.data !== undefined ? extractReasoningSignatureFromData(answer.data, settings) : null);

    const continuedPrefix = pending.isContinue ? continuedReasoningPrefix(pending) : '';
    let mes = parseTarget(pending, generatedText);
    /** @type {{reasoning: string, reasoning_duration: number|null, reasoning_signature: string|null, reasoning_type?: string}} */
    const extra = {
        reasoning: typeof anchorExtra.reasoning === 'string' ? anchorExtra.reasoning : '',
        reasoning_duration: anchorExtra.reasoning_duration ?? null,
        reasoning_signature: signature ?? anchorExtra.reasoning_signature ?? null,
    };
    if (anchorExtra.reasoning_type) extra.reasoning_type = anchorExtra.reasoning_type;

    if (native) {
        // Streamed: trimmed, then regexed (ReasoningHandler.updateReasoning()); not streamed: regexed, then trimmed.
        const reasoning = streamed ? regexed(trimIf(native, settings.trimSpaces), settings) : trimIf(regexed(native, settings), settings.trimSpaces);
        if (pending.isContinue && extra.reasoning && !continuedPrefix) {
            extra.reasoning += reasoning;
        } else {
            extra.reasoning = reasoning;
            extra.reasoning_duration = streamed ? measured : null;
            if (streamed) extra.reasoning_type = ReasoningType.Model;
        }
        if (pending.isContinue && continuedPrefix) mes = mes.slice(continuedPrefix.length);
    } else if (settings.autoParse && (!extra.reasoning || continuedPrefix)) {
        const block = splitReasoningBlock(mes, settings, streamed || Boolean(continuedPrefix));
        if (block) {
            mes = block.content;
            if (block.reasoning) {
                extra.reasoning = regexed(block.reasoning, settings);
                extra.reasoning_type = ReasoningType.Parsed;
                if (streamed) extra.reasoning_duration = measured;
            }
        } else if (continuedPrefix) {
            mes = mes.slice(continuedPrefix.length);
        }
    } else if (continuedPrefix) {
        mes = mes.slice(continuedPrefix.length);
    }

    if (!native && streamed && settings.hiddenReasoningModel && !pending.isContinue && !extra.reasoning) {
        // A model that thinks without sending its reasoning: the time it thought is still shown.
        extra.reasoning_duration = measured;
        extra.reasoning_type = ReasoningType.Model;
    }

    return { mes, extra };
}
