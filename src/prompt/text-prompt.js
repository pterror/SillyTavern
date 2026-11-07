import Handlebars from 'handlebars';

import { getBiasStrings, formatMessageHistoryItem, lastPromptLineParts } from '../prompt-line-formatting.js';
import { getCharacterCardFields, getGroupCharacterDepthPrompts } from '../character-card-fields.js';
import { buildCoreChat, finalizeCoreChatMessage } from '../core-chat-build.js';
import { createReasoningFoldState, foldReasoningIntoMessage, isReasoningLimitReached } from '../reasoning-fold.js';
import { getGuidanceScale, adjustMaxContextForCfg } from '../cfg-prompt-resolve.js';
import { parseDecorators } from '../world-info/decorators.js';
import { activateWorldInfoEntries } from '../world-info/activation.js';
import { buildActivationRecord } from '../world-info/activation-record.js';
import { userStore } from '../user-stores.js';
import { bucketActivatedEntries } from '../world-info/result-bucketing.js';
import { appendFileAttachments } from '../file-attachment-inline.js';
import { resolveAuthorsNote } from '../authors-note.js';
import { getStoppingStrings } from '../stopping-strings.js';
import { getCustomTokenBans, calculateLogitBias } from '../token-bans-and-bias.js';
import { createTextGenGenerationData } from '../textgen-generation-data.js';
import { createKoboldGenerationData } from '../kobold-generation-data.js';
import { createNovelGenerationData } from '../novel-generation-data.js';
import { substituteParams, baseChatReplace } from '../macro-substitution.js';
import { formatInstructModeExampleBlocks } from '../instruct-mode-examples.js';
import { formatInstructModeStoryString, force_output_sequence } from '../instruct-template-format.js';
import { inject_ids, persona_description_defaults, persona_description_positions } from '../../public/scripts/constants.js';
import { presetNameOf, promptParts, samplerConfigOf } from '../prompt-itemization.js';
import { exampleBlocks } from '../example-blocks.js';
import { reasoningOf } from '../../public/scripts/reasoning-block.js';
import { collectSections, findNode, fitBudget, outletMarker, outletMarkers, place, provide, renderText, withoutOutletMarkers } from './model.js';
import { extension_prompt_roles, extension_prompt_types, placeEntry, positionedEntries, roleName } from './injections.js';
import './providers.js';

const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];
const FORMAT_TOKEN = '\u0000\ufffc\u0000\ufffd';
const OUTLET_REFERENCE = /\{\{outlet::([^}]+)\}\}/g;

const DEPTH_ROLE_ORDER = { [extension_prompt_roles.ASSISTANT]: 0, [extension_prompt_roles.USER]: 1, [extension_prompt_roles.SYSTEM]: 2 };

/** @typedef {import('./model.js').Section} Section */

/**
 * @typedef {object} TextCompletionPromptInput
 * @property {string} [type]
 * @property {boolean} [isImpersonate]
 * @property {boolean} [isContinue]
 * @property {boolean} [isSwipe]
 * @property {boolean} [isGroup]
 * @property {boolean} [isDryRun]
 * @property {boolean} [canUseTools]
 * @property {string} [quiet_prompt]
 * @property {boolean} [quietToLoud]
 * @property {string} [quietName]
 * @property {string} [generationTrigger]
 * @property {string} [name1]
 * @property {string} [name2]
 * @property {import('../users.js').UserDirectoryList} directories
 * @property {string} [avatar]
 * @property {string} [groupId]
 * @property {boolean} [preferCharacterPrompt]
 * @property {boolean} [preferCharacterJailbreak]
 * @property {string} [personaDescription]
 * @property {object} [chatMetadata]
 * @property {object[]} chat
 * @property {object|null} [sentMessage]
 * @property {string} [textareaText]
 * @property {string} [userPromptBias]
 * @property {boolean} [alwaysForceName2]
 * @property {boolean} [forceName2Override] The reply's line starts with the character's name (non-instruct only).
 * @property {boolean} [skipWorldInfoAndNote] No lorebook entries and no author's note go in.
 * @property {boolean} [reasoningAddToPrompts]
 * @property {number} [reasoningMaxAdditions]
 * @property {string} [reasoningPrefix]
 * @property {string} [reasoningSeparator]
 * @property {string} [reasoningSuffix]
 * @property {import('./injections.js').PageInjections} [pageInjections]
 * @property {number} thisMaxContext
 * @property {number} [maxContext]
 * @property {number} [tokenPadding]
 * @property {(text: string) => Promise<number>} countTokens
 * @property {(text: string) => Promise<number>} [countPromptTokens]
 * @property {(text: string) => number[] | null | Promise<number[] | null>} encodeTokens
 * @property {(tokenizerType: number, text: string) => number[] | Promise<number[]>} [encodeTokensByType]
 * @property {number} [novelTokenizerType]
 * @property {number} [amountGen]
 * @property {boolean} [requestTokenProbabilities]
 * @property {number} [chatGuidanceScale]
 * @property {boolean} [groupchatIndividualChars]
 * @property {import('../cfg-prompt-resolve.js').CfgSettings} [charaCfg]
 * @property {import('../cfg-prompt-resolve.js').CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine]
 * @property {string} [promptSeparator]
 * @property {number} [promptInsertionDepth]
 * @property {import('../cfg-prompt-resolve.js').ChatMetadataCfgPrompts} [chatMetadataPrompts]
 * @property {import('../world-info/activation.js').WIEntry[]} [worldInfoCandidates]
 * @property {import('../../public/scripts/world-info-globals.js').WorldInfoGlobals} worldInfoGlobals
 * @property {object} [entryFilterContext]
 * @property {() => number} [worldInfoRandom]
 * @property {import('../authors-note.js').AuthorsNoteSettings} [noteSettings]
 * @property {boolean} [hasCharacterOrGroup]
 * @property {string} [storyStringTemplate]
 * @property {number} [storyStringPosition]
 * @property {number} [storyStringDepth]
 * @property {number} [storyStringRole]
 * @property {boolean} [sysPromptEnabled]
 * @property {string} [sysPromptContent]
 * @property {number} [personaDescriptionPosition]
 * @property {number} [personaDescriptionDepth]
 * @property {number} [personaDescriptionRole]
 * @property {boolean} [stripExamples]
 * @property {boolean} [isInstruct]
 * @property {import('../instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {object} [contextSettings]
 * @property {string} [instructUserAlignmentMessage]
 * @property {boolean} [instructWrap]
 * @property {boolean} [pinExamples]
 * @property {string} [sysPromptPostHistory]
 * @property {string} mainApi
 * @property {string} [naiPreamble]
 * @property {string} [chatStart]
 * @property {boolean} [collapseNewlines]
 * @property {boolean} [namesAsStopStrings]
 * @property {boolean} [singleLine]
 * @property {string} [customStoppingStringsRaw]
 * @property {boolean} [customStoppingStringsMacro]
 * @property {string[]} [ephemeralStoppingStrings]
 * @property {string[]} [groupMemberNames]
 * @property {string[]} [groupDisabledMembers]
 * @property {string} [bannedTokensRaw]
 * @property {string} [globalBannedTokensRaw]
 * @property {boolean} [sendBannedTokens]
 * @property {import('../token-bans-and-bias.js').LogitBiasEntry[]} [logitBiasEntries]
 * @property {object} settings
 * @property {string} [model]
 * @property {import('../kobold-generation-data.js').KoboldGenerationFlags} [koboldFlags]
 * @property {boolean} [isHorde]
 * @property {string} [apiServer]
 * @property {number} [novelDataTier]
 * @property {number[]} [presetOrder]
 * @property {boolean} [consoleLogPrompts]
 * @property {import('../macro-substitution.js').SubstituteParamsContext} [macroFacts]
 */

/**
 * @param {string} text
 * @returns {string}
 */
function stripCarriageReturns(text) {
    return text.replace(/\r/gm, '');
}

/**
 * @param {object} options
 * @returns {(args: import('./model.js').ComposeArgs) => string}
 */
function storyStringTemplate({ template, position, instructPreset, isInstruct, contextSettings, name1, name2, macroContext, mesExamples, mesExamplesRaw }) {
    const compiled = Handlebars.compile(String(template ?? '').replace(OUTLET_REFERENCE, (_, name) => outletMarker(name.trim())), { noEscape: true });
    return ({ child }) => {
        const loreBefore = child('lore-before');
        const loreAfter = child('lore-after');
        let output = compiled({
            description: child('card:description'),
            personality: child('card:personality'),
            persona: child('persona'),
            scenario: child('card:scenario'),
            system: child('system'),
            char: name2,
            user: name1,
            wiBefore: loreBefore,
            wiAfter: loreAfter,
            loreBefore,
            loreAfter,
            anchorBefore: child('anchor-before'),
            anchorAfter: child('anchor-after'),
            mesExamples,
            mesExamplesRaw,
        });
        output = substituteParams(output, { ...macroContext, name1, name2 });
        output = output.replace(/^\n+/, '');
        if (output.length > 0 && !output.endsWith('\n') && position !== extension_prompt_types.IN_CHAT) {
            if (!instructPreset.enabled || (instructPreset.wrap && !instructPreset.story_string_suffix)) output += '\n';
        }
        return isInstruct ? formatInstructModeStoryString(output, instructPreset, { ...contextSettings, name1, name2, macroContext }) : output;
    };
}

/**
 * @param {TextCompletionPromptInput} input
 */
/**
 * NovelAI takes an instruction in braces.
 * @param {string} text
 * @param {boolean} braced
 * @returns {string}
 */
function novelInstruction(text, braced) {
    if (!braced) return text;
    const stripped = text.replace(/[[\]]/g, '').trim();
    return stripped.includes('{ ') ? stripped : `{ ${stripped} }`;
}

export async function buildTextCompletionPrompt(input) {
    const {
        type, isImpersonate = false, isContinue = false, isSwipe = false, isGroup = false, isDryRun = false,
        canUseTools = false, quiet_prompt: quietPromptAsGiven, quietToLoud = false, quietName,
        generationTrigger = GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        name1 = '', name2 = '',
        directories, avatar, groupId, preferCharacterPrompt = false, preferCharacterJailbreak = false,
        personaDescription, chatMetadata = {}, chat, sentMessage = null, textareaText = '', userPromptBias = '',
        alwaysForceName2 = false, forceName2Override, skipWorldInfoAndNote = false,
        reasoningAddToPrompts = false, reasoningMaxAdditions = 999999, reasoningPrefix = '', reasoningSeparator = '', reasoningSuffix = '',
        tokenPadding = 0, countTokens, countPromptTokens = countTokens, encodeTokens, encodeTokensByType, novelTokenizerType, amountGen = 0, requestTokenProbabilities = false,
        chatGuidanceScale, groupchatIndividualChars = false, charaCfg, globalCfg, promptCombine = [], promptSeparator, promptInsertionDepth = 1, chatMetadataPrompts = {},
        worldInfoCandidates = [], worldInfoGlobals,
        entryFilterContext = {}, worldInfoRandom = Math.random,
        noteSettings = {}, hasCharacterOrGroup = false,
        storyStringTemplate: template = '', storyStringPosition = 0, storyStringDepth = 1, storyStringRole = 0,
        sysPromptEnabled = false, sysPromptContent = '', personaDescriptionPosition = 0, stripExamples = false,
        personaDescriptionDepth = persona_description_defaults.depth, personaDescriptionRole = persona_description_defaults.role,
        isInstruct = false, instructPreset = {}, contextSettings = {}, instructUserAlignmentMessage,
        instructWrap = false, pinExamples = false,
        sysPromptPostHistory = '',
        mainApi, naiPreamble = '', chatStart = '', collapseNewlines = false,
        namesAsStopStrings = false, singleLine = false, customStoppingStringsRaw, customStoppingStringsMacro = false,
        ephemeralStoppingStrings = [], groupMemberNames = [], groupDisabledMembers = [],
        bannedTokensRaw = '', globalBannedTokensRaw = '', sendBannedTokens = false, logitBiasEntries = [],
        settings = {}, model,
        koboldFlags = {}, isHorde = false, apiServer, novelDataTier, presetOrder, consoleLogPrompts = false,
        macroFacts = {},
    } = input;

    if (typeof countTokens !== 'function') throw new Error('buildTextCompletionPrompt: countTokens is required');
    if (typeof encodeTokens !== 'function') throw new Error('buildTextCompletionPrompt: encodeTokens is required');
    if (mainApi === 'novel' && typeof encodeTokensByType !== 'function') throw new Error('buildTextCompletionPrompt: encodeTokensByType is required for novel');
    if (mainApi === 'novel' && typeof novelTokenizerType !== 'number') throw new Error('buildTextCompletionPrompt: novelTokenizerType is required for novel');

    const bannedWordsSink = [];
    const baseMacroContext = { ...macroFacts, name1, name2, isGroup, groupMembers: groupMemberNames, groupDisabledMembers, chat, chatMetadata, bannedWordsSink, outlets: outletMarkers };
    const { messageBias, promptBias, isUserPromptBias } = getBiasStrings({ textareaText, type, chat, userPromptBias, macroContext: baseMacroContext });

    const fields = await getCharacterCardFields(directories, {
        avatar, groupId, preferCharacterPrompt, preferCharacterJailbreak, personaDescription, chatMetadata,
        macroContext: baseMacroContext,
    });

    const macroContext = {
        ...baseMacroContext,
        characterCard: {
            system: fields.system, jailbreak: fields.jailbreak, description: fields.description, personality: fields.personality,
            scenario: fields.scenario, persona: fields.persona, mesExamples: fields.mesExamples, mesExamplesRaw: fields.mesExamples,
            charVersion: fields.version, charDepthPrompt: fields.charDepthPrompt, creatorNotes: fields.creatorNotes,
        },
    };
    const substitute = (/** @type {string} */ text) => substituteParams(text, macroContext);
    const quiet_prompt = quietPromptAsGiven ? novelInstruction(substitute(quietPromptAsGiven), mainApi === 'novel' && !quietToLoud) : quietPromptAsGiven;

    let coreChat = buildCoreChat(chat, { canUseTools, isSwipe });
    const scannedMessages = coreChat.map(m => ({ nodeId: m === sentMessage ? null : (m.node_id ?? ''), text: m.mes ?? '' })).reverse();
    coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {
        const message = chatItem === chat[0] ? substituteParams(chatItem.mes ?? '', macroContext) : chatItem.mes;
        const resolvedMessage = await appendFileAttachments(chatItem.extra, message, { directories });
        return finalizeCoreChatMessage(chatItem, index, resolvedMessage);
    }));

    let reasoningState = createReasoningFoldState();
    const reasoningConfig = { addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions, reasoningPrefix, reasoningSeparator, reasoningSuffix, macroContext };
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const isPrefix = isContinue && i === coreChat.length - 1;
        const isOtherGroupMember = isGroup && coreChat[i].name !== name2;
        if (!isOtherGroupMember) {
            const reasoning = reasoningOf(coreChat[i].extra);
            const duration = coreChat[i].extra?.reasoning_duration ?? null;
            const { content, state } = foldReasoningIntoMessage(reasoningState, coreChat[i].mes, reasoning, isPrefix, duration, reasoningConfig);
            reasoningState = state;
            coreChat[i] = { ...coreChat[i], mes: content };
        }
        if (isReasoningLimitReached(reasoningState, { addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions })) break;
    }

    const cfgGuidanceScale = getGuidanceScale({ chatGuidanceScale, groupchatIndividualChars, isGroup, charaCfg, globalCfg });
    const { thisMaxContext, negativePrompt, positivePrompt } = await adjustMaxContextForCfg({
        cfgGuidanceScale, thisMaxContext: input.thisMaxContext, countTokens,
        chatMetadataPrompts, charaCfg, globalCfg, promptCombine, promptSeparator, promptInsertionDepth, macroContext,
    });

    /** @type {ReturnType<typeof resolveAuthorsNote>} */
    const authorsNote = skipWorldInfoAndNote ? { disabled: true } : resolveAuthorsNote({ chatMetadata, noteSettings, chat, avatar, hasCharacterOrGroup });

    const chatForWI = coreChat.map(x => worldInfoGlobals.world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
    const decoratedCandidates = (skipWorldInfoAndNote ? [] : worldInfoCandidates).map(entry => {
        const [decorators, content] = parseDecorators(entry.content || '');
        return { ...entry, decorators, content };
    });
    const globalScanData = {
        personaDescription: withoutOutletMarkers(fields.persona),
        characterDescription: withoutOutletMarkers(fields.description),
        characterPersonality: withoutOutletMarkers(fields.personality),
        characterDepthPrompt: withoutOutletMarkers(fields.charDepthPrompt),
        scenario: withoutOutletMarkers(fields.scenario),
        creatorNotes: withoutOutletMarkers(fields.creatorNotes),
        trigger: generationTrigger,
    };
    const scanInjects = [
        ['quiet', quiet_prompt],
        ['note', authorsNote.disabled === false && authorsNote.scan ? authorsNote.value : ''],
    ].filter(([, text]) => Boolean(text));
    const { activatedEntries, trace } = await activateWorldInfoEntries(decoratedCandidates, chatForWI, {
        maxContext: thisMaxContext, globals: worldInfoGlobals,
        globalScanData, macroContext, countTokens, random: worldInfoRandom, chatMetadata, isDryRun,
        entryFilterContext, additionalScanInjects: scanInjects.map(([, text]) => text),
    });
    const activations = isDryRun || !directories ? null : await buildActivationRecord(trace, {
        messages: scannedMessages,
        injects: scanInjects.map(([label]) => label),
        books: (await userStore(directories)).lib.books,
    });
    const lore = bucketActivatedEntries(activatedEntries);

    const rawExampleBlocks = exampleBlocks(fields.mesExamples, lore.worldInfoExamples, {
        mainApi, isInstruct, exampleSeparator: contextSettings.example_separator, macroContext,
    });
    const formattedExampleBlocks = isInstruct
        ? formatInstructModeExampleBlocks(rawExampleBlocks, name1, name2, { instructPreset, contextSettings, isGroup, macroContext }).map(block => block.join(''))
        : rawExampleBlocks;
    const mesExamples = formattedExampleBlocks.join('');

    let system = '';
    if (mainApi !== 'openai' && sysPromptEnabled) {
        system = preferCharacterPrompt && fields.system
            ? substituteParams(fields.system, { ...macroContext, original: sysPromptContent ?? '' })
            : baseChatReplace(sysPromptContent, { ...macroContext, name1, name2 });
        system = isInstruct ? substituteParams(system, { ...macroContext, original: sysPromptContent ?? '' }) : system;
    }

    const storyStringAtDepth = storyStringPosition === extension_prompt_types.IN_CHAT;
    const storyStringId = storyStringAtDepth ? `inject:${inject_ids.STORY_STRING}` : 'story-string';

    const storyString = {
        id: storyStringId, part: 'story_string',
        compose: storyStringTemplate({
            template, position: storyStringPosition, instructPreset, isInstruct,
            contextSettings, name1, name2, macroContext, mesExamples, mesExamplesRaw: rawExampleBlocks.join(''),
        }),
        outlets: [...String(template).matchAll(OUTLET_REFERENCE)].map(match => match[1].trim()),
    };

    const groupDepthPrompts = isGroup && hasCharacterOrGroup ? await getGroupCharacterDepthPrompts(directories, groupId, avatar, baseMacroContext) : [];
    const entries = positionedEntries({
        pageInjections: input.pageInjections, authorsNote, anBefore: lore.anBefore, anAfter: lore.anAfter,
        personaDescription, personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole,
        worldInfoDepth: lore.worldInfoDepth,
        storyStringAtDepth: storyStringAtDepth ? storyString : null, storyStringDepth, storyStringRole,
        groupDepthPrompts,
        characterDepthPrompt: hasCharacterOrGroup ? { text: fields.charDepthPrompt || '', depth: fields.charDepthPromptDepth, role: fields.charDepthPromptRole } : null,
        substitute,
    });

    /** @type {Section[]} */
    const sections = [];
    const card = await provide('card', fields);
    const persona = personaDescriptionPosition == persona_description_positions.IN_PROMPT ? await provide('persona', { description: fields.persona }) : [];
    if (!storyStringAtDepth) sections.push({ ...storyString, order: 0 });
    for (const field of [...card, ...persona]) sections.push({ ...field, parent: storyStringId });
    sections.push({ id: 'system', parent: storyStringId, text: system, part: 'system_prompt' });
    sections.push({ id: 'lore-before', parent: storyStringId, join: '\n', part: 'world_info' });
    sections.push({ id: 'lore-after', parent: storyStringId, join: '\n', part: 'world_info' });
    lore.worldInfoBeforeEntries.forEach((text, i) => sections.push({ id: `lore:before:${i}`, parent: 'lore-before', order: i, text, part: 'world_info' }));
    lore.worldInfoAfterEntries.forEach((text, i) => sections.push({ id: `lore:after:${i}`, parent: 'lore-after', order: i, text, part: 'world_info' }));
    for (const [name, texts] of Object.entries(lore.outletEntries)) {
        texts.forEach((text, i) => sections.push({ id: `lore:outlet:${name}:${i}`, parent: `outlet:${name}`, order: i, text, part: 'world_info' }));
    }
    sections.push({ id: 'anchor-before', parent: storyStringId, join: '\n', skipEmpty: true, trimEach: true, trim: 'both', part: 'extensions' });
    sections.push({ id: 'anchor-after', parent: storyStringId, join: '\n', skipEmpty: true, trimEach: true, trim: 'both', part: 'extensions' });

    sections.push({
        id: 'examples', order: 1, provider: 'examples', budget: 'trim', trimFrom: 'end', priority: pinExamples ? -1 : 1, part: 'examples',
    });
    if (mainApi === 'novel') sections.push({ id: 'preamble', order: 2, text: substituteParams(naiPreamble, macroContext) + '\n', part: 'chat_start' });
    if (chatStart) sections.push({ id: 'chat-start', order: 3, text: substituteParams(chatStart + '\n', macroContext), part: 'chat_start' });
    sections.push({ id: 'history', order: 4, provider: 'history', budget: 'trim', trimFrom: 'start', priority: 0 });

    /** @type {Map<string, Section>} */
    const wrappers = new Map();
    for (const entry of entries) {
        if (entry.position === extension_prompt_types.BEFORE_PROMPT) sections.push(...placeEntry(entry, 'anchor-before'));
        else if (entry.position === extension_prompt_types.IN_PROMPT) sections.push(...placeEntry(entry, 'anchor-after'));
        else if (entry.position === extension_prompt_types.IN_CHAT && Number.isFinite(entry.depth)) {
            const id = `depth:${entry.depth}:${entry.role}`;
            if (!wrappers.has(id)) {
                const bumped = isContinue && entry.depth === 0;
                wrappers.set(id, {
                    id, parent: 'history', at: { fromEnd: bumped ? 1 : entry.depth },
                    order: (bumped ? 10 : 0) + (DEPTH_ROLE_ORDER[entry.role] ?? 2),
                    role: roleName(entry.role), name: entry.role === extension_prompt_roles.USER ? name1 : entry.role === extension_prompt_roles.ASSISTANT ? name2 : '',
                    join: '\n', skipEmpty: true, trimEach: true, trim: 'start', part: 'injections',
                });
            }
            sections.push(...placeEntry(entry, id));
        }
    }
    sections.push(...wrappers.values());

    const jailbreak = sysPromptEnabled
        ? (preferCharacterJailbreak && fields.jailbreak
            ? substituteParams(fields.jailbreak, { ...macroContext, original: sysPromptPostHistory ?? '' })
            : baseChatReplace(sysPromptPostHistory))
        : '';
    const historyItems = coreChat.length + wrappers.size + (jailbreak ? 1 : 0);
    const continuedShifted = isContinue && historyItems > 1;
    if (jailbreak) {
        sections.push({
            id: 'after-history', parent: 'history', at: isContinue ? { fromEnd: 1 } : { last: true }, order: 100,
            role: 'user', name: '', text: jailbreak, part: 'post_history',
        });
    }

    const forceName2 = isImpersonate ? false : (((promptBias && !isUserPromptBias) || alwaysForceName2 || mainApi === 'novel') ? true : Boolean(forceName2Override));
    const lastLine = lastPromptLineParts({
        quiet_prompt, name1, name2, isInstruct, quietToLoud, type, quietName, isImpersonate, promptBias,
        chat, force_name2: forceName2, isContinue, isGroup, instructPreset, macroContext,
    });
    const trimNewline = type !== 'continue' && (!isInstruct || (instructWrap && type !== 'quiet'));
    const lastLineAt = /** @type {import('./model.js').Position} */ (continuedShifted ? { fromEnd: 1 } : { last: true });
    (lastLine.length ? lastLine : [{ text: '' }]).forEach((part, i) => {
        sections.push({
            id: `reply-start:${i}`, parent: 'history', at: lastLineAt, order: 200 + i, text: part.text, part: 'chat_history',
            joins: { trimNewline: i === 0 && trimNewline, breakBefore: part.breakBefore },
        });
    });

    if (positivePrompt?.value) {
        const depth = Number(positivePrompt.depth) + (continuedShifted ? 1 : 0);
        sections.push(Number(positivePrompt.depth) === 0
            ? { id: 'guidance', parent: 'history', at: { fromEndRendered: depth }, order: 0, text: positivePrompt.value, joins: { spaceBefore: true }, part: 'injections' }
            : { id: 'guidance', parent: 'history', at: { fromEndRendered: depth }, order: 0, text: `${positivePrompt.value}\n`, part: 'injections' });
    }
    if (!isInstruct && !isImpersonate && promptBias.trim().length !== 0) {
        sections.push({ id: 'bias', parent: 'history', at: { fromEndRendered: 0 }, order: 1, text: promptBias.trimStart(), joins: { spaceBefore: true }, part: 'bias' });
    }

    const addUserAlignment = Boolean(isInstruct && instructUserAlignmentMessage);
    const historyState = { format: 'text', items: coreChat, continued: isContinue };
    const examplesState = { format: 'text', blocks: stripExamples ? [] : formattedExampleBlocks };
    let collected = await collectSections(sections, { type }, { history: historyState, examples: examplesState });
    if (addUserAlignment && !firstChatItemIsUser(collected)) {
        const alignment = formatMessageHistoryItem(
            { name: name1, mes: substituteParams(instructUserAlignmentMessage, macroContext), is_user: true },
            isInstruct, force_output_sequence.FIRST, { isGroup, name1, name2, instructPreset, macroContext },
        );
        collected = [...collected, { id: 'alignment', parent: 'history', at: { first: true }, text: alignment, part: 'injections' }];
    }

    const { root } = place(collected);
    const formatContext = { isGroup, name1, name2, instructPreset, macroContext };
    const formatMessage = (/** @type {Section} */ section, inner, variant) => {
        const item = {
            name: section.name, mes: inner, is_user: section.role === 'user', force_avatar: section.data?.forceAvatar,
            extra: { type: section.role === 'system' ? 'narrator' : null, ignore: section.data?.ignore === true },
        };
        if (variant.continued) {
            if (!isInstruct) {
                const text = formatMessageHistoryItem(item, false, false, formatContext);
                return text.slice(0, text.lastIndexOf(inner) + inner.length);
            }
            const marked = { ...item, mes: inner.replaceAll(FORMAT_TOKEN, '') + FORMAT_TOKEN };
            const text = formatMessageHistoryItem(marked, true, force_output_sequence.LAST, formatContext);
            return text.includes(FORMAT_TOKEN) ? text.slice(0, text.lastIndexOf(FORMAT_TOKEN)) : text;
        }
        const force = !isInstruct ? false : variant.lastUser ? force_output_sequence.LAST : variant.first ? force_output_sequence.FIRST : false;
        return formatMessageHistoryItem(item, isInstruct, force, formatContext);
    };
    const finish = (/** @type {string} */ text) => {
        const plain = stripCarriageReturns(text);
        return collapseNewlines ? plain.replaceAll(/\n+/g, '\n') : plain;
    };

    const { rendered, excluded } = await fitBudget(root, {
        budget: thisMaxContext - tokenPadding,
        render: async (excludedIds, unitOf) => renderText(root, { excluded: excludedIds, unitOf, formatMessage, lastUserVariant: !isImpersonate }),
        measure: async (full) => {
            const kept = full.pieces.filter(p => p.unit === null).map(p => p.text).join('');

            /** @type {Map<string, string>} */
            const unitTexts = new Map();
            for (const piece of full.pieces) if (piece.unit !== null) unitTexts.set(piece.unit, (unitTexts.get(piece.unit) ?? '') + piece.text);

            /** @type {Map<string, number>} */
            const units = new Map();
            for (const [unit, text] of unitTexts) units.set(unit, await countTokens(finish(text)));
            return {
                kept: await countPromptTokens(finish(kept)),
                units,
                describeKept: async () => {
                    /** @type {Map<string, string>} */
                    const bySection = new Map();
                    for (const piece of full.pieces) if (piece.unit === null) bySection.set(piece.section.id, (bySection.get(piece.section.id) ?? '') + piece.text);
                    return Promise.all([...bySection].map(async ([id, text]) => ({ id, tokens: await countTokens(finish(text)) })));
                },
            };
        },
    });

    const combinedPrompt = finish(rendered.text);

    const stoppingStringsParams = {
        namesAsStopStrings, name1, name2, chat, isGroup, groupMemberNames,
        singleLine, instructPreset, contextSettings, customStoppingStringsRaw, customStoppingStringsMacro,
        ephemeralStoppingStrings, macroContext,
    };
    const stoppingStrings = getStoppingStrings({ ...stoppingStringsParams, isImpersonate, isContinue, api: mainApi });
    const isTextgen = mainApi !== 'kobold' && mainApi !== 'novel';

    /** @type {string[]} */
    const droppedEntries = [];
    const { banned_tokens: bannedTokens, banned_strings: bannedStrings } = await getCustomTokenBans({
        bannedTokensRaw, globalBannedTokensRaw, sendBannedTokens, bannedWordsFromMacros: bannedWordsSink,
        encode: isTextgen ? encodeTokens : () => null, macroContext,
        dropped: isTextgen ? droppedEntries : undefined,
    });
    const logitBias = isTextgen ? await calculateLogitBias({ logitBiasEntries, encode: encodeTokens, dropped: droppedEntries }) : {};

    const cfgValues = { guidanceScale: cfgGuidanceScale, negativePrompt: negativePrompt?.value };
    let generate_data;
    if (mainApi === 'kobold') {
        generate_data = createKoboldGenerationData({
            finalPrompt: combinedPrompt, settings, maxLength: amountGen, maxContextLength: input.maxContext ?? input.thisMaxContext,
            isHorde, type, koboldSettings: settings, koboldFlags, apiServer, stoppingStringsParams, macroContext,
        });
    } else if (mainApi === 'novel') {
        generate_data = await createNovelGenerationData({
            finalPrompt: combinedPrompt, settings, maxLength: amountGen, isImpersonate, isContinue, type, novelDataTier, presetOrder,
            consoleLogPrompts, requestTokenProbabilities, stoppingStringsParams, tokenizerType: novelTokenizerType,
            encodeTokens: encodeTokensByType, dropped: droppedEntries, macroContext,
        });
    } else {
        generate_data = await createTextGenGenerationData(settings, model, combinedPrompt, amountGen, isImpersonate, isContinue, cfgValues, type, {
            stoppingStrings, bannedTokens, bannedStrings, logitBias, maxContext: thisMaxContext, requestTokenProbabilities, macroContext,
        });
    }

    const itemize = () => itemizeTextPrompt({
        api: isHorde ? 'koboldhorde' : mainApi, settings, generate_data, combinedPrompt, thisMaxContext, tokenPadding,
        pieces: rendered.pieces, sectionTexts: rendered.rendered, jailbreak, promptBias, finish,
        continuedShifted, storyStringId,
    }, { countTokens, countPromptTokens });

    return {
        combinedPrompt, generate_data, itemize, droppedEntries, activations,
        messageBias, promptBias, isUserPromptBias, characterCardFields: fields,
        thisMaxContext, negativePrompt, positivePrompt,
        worldInfoBefore: lore.worldInfoBefore, worldInfoAfter: lore.worldInfoAfter, worldInfoExamples: lore.worldInfoExamples,
        worldInfoDepth: lore.worldInfoDepth, anBefore: lore.anBefore, anAfter: lore.anAfter, outletEntries: lore.outletEntries,
        authorsNote, system, jailbreak, stoppingStrings, bannedTokens, bannedStrings, logitBias,
        excluded,
    };
}

/**
 * @param {Section[]} sections
 * @returns {boolean}
 */
function firstChatItemIsUser(sections) {
    const { root } = place(sections);
    const history = findNode(root, 'history');
    const first = history?.items.find(item => typeof item === 'object' && item.section.role);
    return typeof first === 'object' && first.section.role === 'user';
}

/**
 * @param {object} parts
 * @param {{ countTokens: (text: string) => Promise<number>, countPromptTokens: (text: string) => Promise<number> }} counters
 * @returns {Promise<Omit<import('../prompt-itemization.js').PromptItemization, 'tokenizer'>>}
 */
async function itemizeTextPrompt(parts, { countTokens, countPromptTokens }) {
    const count = async (/** @type {string|undefined|null} */ text) => (text ? countTokens(parts.finish(text)) : 0);

    const pieces = parts.pieces;
    const story = parts.sectionTexts.get(parts.storyStringId) ?? '';
    const storyInPrompt = pieces.some(p => p.section.id === parts.storyStringId);

    const storyMembers = [
        ['system_prompt', parts.sectionTexts.get('system')], ['world_info', parts.sectionTexts.get('lore-before')],
        ['description', parts.sectionTexts.get('card:description')], ['personality', parts.sectionTexts.get('card:personality')],
        ['scenario', parts.sectionTexts.get('card:scenario')], ['world_info', parts.sectionTexts.get('lore-after')],
        ['persona', parts.sectionTexts.get('persona')], ['extensions', parts.sectionTexts.get('anchor-before')],
        ['extensions', parts.sectionTexts.get('anchor-after')],
    ];
    const inStory = storyInPrompt ? storyMembers
        .map(([part, text]) => ({ part, text: text ?? '', at: text ? story.indexOf(text) : -1 }))
        .filter(member => member.at >= 0)
        .sort((x, y) => x.at - y.at) : [];

    const inHistory = pieces.filter(p => p.container === 'history');
    const injected = inHistory.filter(p => p.section.part === 'injections' || p.section.id.startsWith('depth:'));
    const historyText = inHistory.filter(p => !injected.includes(p)).map(p => p.text).join('');
    const biasInHistory = pieces.some(p => p.section.id === 'bias');
    const examples = pieces.filter(p => p.section.part === 'examples' && p.section.id.startsWith('example:'));

    const [total, storyTokens, memberTokens, exampleTokens, historyTokens, injections, postHistoryTokens, bias] = await Promise.all([
        parts.combinedPrompt ? countPromptTokens(parts.combinedPrompt) : 0,
        storyInPrompt ? count(story) : 0,
        Promise.all(inStory.map(member => count(member.text))),
        count(examples.map(p => p.text).join('')),
        count(historyText),
        count(injected.map(p => p.text).join('')),
        count(parts.jailbreak),
        count(parts.promptBias),
    ]);
    const membersTotal = memberTokens.reduce((a, b) => a + b, 0);
    const messages = inHistory.filter(p => p.section.id.startsWith('message:')).length - (parts.continuedShifted ? 1 : 0);

    return {
        api: parts.api,
        preset: presetNameOf(parts.api, parts.settings),
        sampler_config: samplerConfigOf(parts.generate_data, ['prompt', 'input']),
        max_context: parts.thisMaxContext,
        padding: parts.tokenPadding,
        rawPrompt: parts.combinedPrompt,
        messages_count: Math.max(0, messages),
        examples_count: examples.length,
        total,
        parts: promptParts(/** @type {[import('../prompt-itemization.js').PromptPartName, number][]} */ ([
            ['story_string', Math.max(0, storyTokens - membersTotal)],
            ...inStory.map((member, i) => ([member.part, memberTokens[i]])),
            ['examples', exampleTokens],
            ['chat_history', Math.max(0, historyTokens - (parts.jailbreak && pieces.some(p => p.section.id === 'after-history') ? postHistoryTokens : 0) - (biasInHistory ? bias : 0))],
            ['injections', injections],
            ['post_history', pieces.some(p => p.section.id === 'after-history') ? postHistoryTokens : 0],
            ['bias', biasInHistory ? bias : 0],
        ])),
    };
}
