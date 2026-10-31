import { CHAT_COMPLETION_SOURCES, TEXTGEN_TYPES } from './constants.js';
import { substituteParams } from './macro-substitution.js';
import { cleanUpReply } from './reply-cleanup.js';
import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { readSettingsFor, settingsContextOf } from './settings-reads.js';

export const ReasoningType = {
    Model: 'model',
    Parsed: 'parsed',
};

const REASONING_PLACEHOLDER = '​';

const HIDDEN_REASONING_MODELS = ['gpt-4.5', 'o1', 'o3', 'gemini-2.0-flash-thinking-exp', 'gemini-2.0-pro-exp'];

/**
 * @typedef {object} ReplyFinishBase
 * @property {string} mainApi
 * @property {string|null} source
 * @property {boolean} showThoughts
 * @property {boolean} hiddenReasoningModel
 * @property {boolean} autoParse
 * @property {string} prefix
 * @property {string} suffix
 * @property {string} promptPrefix
 * @property {boolean} trimSpaces
 * @property {string} replyBias
 * @property {object[]} regexScripts
 * @property {boolean} regexEnabled
 * @property {{name1: string, name2: string}} macroContext
 * @property {string} api
 * @property {string|null|Promise<string|null>} model
 * @typedef {ReplyFinishBase & import('./reply-cleanup.js').ReplyCleanupSettings} ReplyFinishSettings
 */

const PRESET_SETTINGS = {
    openai: { key: 'oai_settings', name: 'preset_settings_openai' },
    textgenerationwebui: { key: 'textgenerationwebui_settings', name: 'preset' },
    kobold: { key: 'kai_settings', name: 'preset_settings' },
    koboldhorde: { key: 'kai_settings', name: 'preset_settings' },
    novel: { key: 'nai_settings', name: 'preset_settings_novel' },
};

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} params.mainApi
 * @param {string|null} [params.source]
 * @param {string|null|Promise<string|null>} [params.model]
 * @param {string|null} [params.avatar]
 * @param {string|null} [params.groupId]
 * @param {string} [params.name1]
 * @param {string} [params.name2]
 * @returns {Promise<ReplyFinishSettings>}
 */
export async function readReplyFinishSettings(directories, { mainApi, source = null, model = null, avatar = null, groupId = null, name1 = '', name2 = '' }) {
    const preset = PRESET_SETTINGS[mainApi];
    const paths = ['power_user', 'extension_settings', 'oai_settings.show_thoughts'];
    if (preset) paths.push(`${preset.key}.${preset.name}`, `${preset.key}.extensions`);
    /** @type {any} */
    const settings = readSettingsFor(directories, settingsContextOf({ avatar, groupId }), paths);
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

    /** @type {string[]} */
    const groupMemberNames = [];
    if (groupId) {
        try {
            const { getGroupsByIds } = await import('./endpoints/groups.js');
            const { readCardContent } = await import('./endpoints/characters.js');
            const group = /** @type {any} */ ((await getGroupsByIds(directories, [groupId]))[groupId]);
            for (const member of Array.isArray(group?.members) ? group.members : []) {
                const raw = await readCardContent(directories, member);
                const card = raw === undefined ? null : JSON.parse(raw);
                const memberName = card?.name || card?.data?.name;
                if (memberName) groupMemberNames.push(memberName);
            }
        } catch (error) {
            console.warn('Could not read the group\'s members for cleaning up the reply:', error);
        }
    }
    const context = powerUser.context ?? {};

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
        api: mainApi === 'openai' ? (source || 'openai') : mainApi === 'textgenerationwebui' ? (source === 'ooba' ? 'textgenerationwebui' : String(source ?? '')) : mainApi,
        model,
        name1, name2,
        stoppingStringsParams: {
            namesAsStopStrings: context.names_as_stop_strings !== false,
            name1, name2,
            isGroup: Boolean(groupId),
            groupMemberNames: groupMemberNames.map(name => ({ name })),
            singleLine: Boolean(powerUser.single_line),
            instructPreset: powerUser.instruct ?? {},
            contextSettings: context,
            customStoppingStringsRaw: powerUser.custom_stopping_strings ?? '',
            customStoppingStringsMacro: powerUser.custom_stopping_strings_macro !== false,
            macroContext,
        },
        collapseNewlines: Boolean(powerUser.collapse_newlines),
        allowName1Display: Boolean(powerUser.allow_name1_display),
        allowName2Display: Boolean(powerUser.allow_name2_display),
        instruct: powerUser.instruct ?? {},
        isGroup: Boolean(groupId),
        groupMemberNames,
        disableGroupTrimming: Boolean(powerUser.disable_group_trimming),
        trimSentences: Boolean(powerUser.trim_sentences),
    };
}

/**
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
 * @param {string} text
 * @param {{prefix: string, suffix: string, trimSpaces: boolean}} settings
 * @param {boolean} streamed
 * @returns {{reasoning: string, content: string}|null}
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
 * @typedef {object} ReplyStream
 * @property {string} reasoning
 * @property {number|null} reasoningEndedAt
 * @property {string|null} signature
 * @property {boolean} parseOff
 * @property {number} suffixFrom
 */

/**
 * @param {object|null|undefined} pending
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
 * @param {object|null|undefined} pending
 * @param {string} text
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
    const { prefix, suffix } = settings;
    const target = parseTarget(pending, text);
    if (target.length <= prefix.length) return;
    if (!target.startsWith(prefix)) {
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
 * @param {object} pending
 * @param {string} generatedText
 * @param {{data?: any}} [answer]
 * @returns {{mes: string, extra: {reasoning: string, reasoning_duration: number|null, reasoning_signature: string|null, reasoning_type?: string, api?: string, model?: string}}}
 */
export function finishReply(pending, generatedText, answer = {}) {
    /** @type {any} */
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
    let mes;
    if (pending.finish) {
        const oldText = pending.isContinue && typeof pending.anchorContent?.mes === 'string' ? pending.anchorContent.mes : '';
        mes = continuedPrefix + cleanUpReply(oldText + generatedText, settings, {
            isContinue: Boolean(pending.isContinue),
            lastIsUser: Boolean(pending.isContinue && pending.anchorContent?.is_user),
            keepSpaces: Boolean(continuedPrefix),
        });
    } else {
        mes = parseTarget(pending, generatedText);
    }
    /** @type {{reasoning: string, reasoning_duration: number|null, reasoning_signature: string|null, reasoning_type?: string, api?: string, model?: string}} */
    const extra = {
        reasoning: typeof anchorExtra.reasoning === 'string' ? anchorExtra.reasoning : '',
        reasoning_duration: anchorExtra.reasoning_duration ?? null,
        reasoning_signature: signature ?? anchorExtra.reasoning_signature ?? null,
    };
    if (anchorExtra.reasoning_type) extra.reasoning_type = anchorExtra.reasoning_type;

    if (native) {
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
        extra.reasoning_duration = measured;
        extra.reasoning_type = ReasoningType.Model;
    }

    return { mes, extra };
}
