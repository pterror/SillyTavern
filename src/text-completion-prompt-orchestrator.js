import { getBiasStrings } from './prompt-line-formatting.js';
import { getCharacterCardFields, getGroupCharacterDepthPrompts } from './character-card-fields.js';
import { buildCoreChat, finalizeCoreChatMessage } from './core-chat-build.js';
import { createReasoningFoldState, foldReasoningIntoMessage, isReasoningLimitReached } from './reasoning-fold.js';
import { getGuidanceScale, adjustMaxContextForCfg } from './cfg-prompt-resolve.js';
import { parseDecorators } from './world-info/decorators.js';
import { activateWorldInfoEntries } from './world-info/activation.js';
import { buildActivationRecord } from './world-info/activation-record.js';
import { userStore } from './user-stores.js';
import { bucketActivatedEntries, world_info_position } from './world-info/result-bucketing.js';
import { getRegexedString, regex_placement } from './regex-scripts-engine.js';
import { appendFileAttachments } from './file-attachment-inline.js';
import { resolveAuthorsNote } from './authors-note.js';
import { assembleStoryString } from './story-string-assembly.js';
import { injectJailbreak, buildChat2, fillContextBudget, estimateExampleBudget, buildMesSend } from './chat-history-budget.js';
import { addChatsPreamble, addChatsSeparator, resolvePromptStrings } from './prompt-size-backoff.js';
import { modifyLastPromptLine } from './prompt-line-formatting.js';
import { combineFinalPrompt } from './final-prompt-combination.js';
import { getStoppingStrings } from './stopping-strings.js';
import { getCustomTokenBans, calculateLogitBias } from './token-bans-and-bias.js';
import { createTextGenGenerationData } from './textgen-generation-data.js';
import { createKoboldGenerationData } from './kobold-generation-data.js';
import { createNovelGenerationData } from './novel-generation-data.js';
import { substituteParams } from './macro-substitution.js';
import { formatInstructModeExamples } from './instruct-mode-examples.js';
import { createExtensionPromptTable, getExtensionPrompt, doChatInject, extension_prompt_types } from './extension-prompt-table.js';
import { persona_description_defaults } from '../public/scripts/constants.js';
import { addDepthInjections, addNoteAndPersona, addPageInjections } from './prompt-injections.js';
import { exampleBlocks } from './example-blocks.js';
import { reasoningOf } from '../public/scripts/reasoning-block.js';

const GENERATION_TYPE_TRIGGERS = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate'];

/** @typedef {import('./macro-substitution.js').SubstituteParamsContext} SubstituteParamsContext */

/**
 * @typedef {object} AssembleTextCompletionPromptInput
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
 * @property {import('./users.js').UserDirectoryList} directories
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
 * @property {boolean} [forceName2Override]
 * @property {boolean} [reasoningAddToPrompts]
 * @property {number} [reasoningMaxAdditions]
 * @property {string} [reasoningPrefix]
 * @property {string} [reasoningSeparator]
 * @property {string} [reasoningSuffix]
 * @property {import('./regex-scripts-engine.js').RegexScript[]} [regexScripts]
 * @property {boolean} [regexExtensionEnabled]
 * @property {import('./extension-prompt-table.js').ExtensionPromptTable} [pageInjections]
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
 * @property {import('./cfg-prompt-resolve.js').CfgSettings} [charaCfg]
 * @property {import('./cfg-prompt-resolve.js').CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine]
 * @property {string} [promptSeparator]
 * @property {number} [promptInsertionDepth]
 * @property {import('./cfg-prompt-resolve.js').ChatMetadataCfgPrompts} [chatMetadataPrompts]
 * @property {import('./world-info/activation.js').WIEntry[]} [worldInfoCandidates]
 * @property {import('../public/scripts/world-info-globals.js').WorldInfoGlobals} worldInfoGlobals
 * @property {object} [entryFilterContext]
 * @property {Map<string, object>} [externalActivations]
 * @property {() => number} [worldInfoRandom]
 * @property {import('./authors-note.js').AuthorsNoteSettings} [noteSettings]
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
 * @property {string} [beforeScenarioAnchor]
 * @property {string} [afterScenarioAnchor]
 * @property {boolean} [isInstruct]
 * @property {import('./instruct-template-format.js').InstructSettings} [instructPreset]
 * @property {object} [contextSettings]
 * @property {string} [instructUserAlignmentMessage]
 * @property {boolean} [instructWrap]
 * @property {boolean} [pinExamples]
 * @property {string} [sysPromptPostHistory]
 * @property {number[]} [injectedIndices]
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
 * @property {import('./token-bans-and-bias.js').LogitBiasEntry[]} [logitBiasEntries]
 * @property {object} settings
 * @property {string} [model]
 * @property {import('./kobold-generation-data.js').KoboldGenerationFlags} [koboldFlags]
 * @property {boolean} [isHorde]
 * @property {string} [apiServer]
 * @property {number} [novelDataTier]
 * @property {number[]} [presetOrder]
 * @property {boolean} [consoleLogPrompts]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroFacts]
 */

/**
 * @param {AssembleTextCompletionPromptInput} input
 */
export async function assembleTextCompletionPrompt(input) {
    const {
        type, isImpersonate = false, isContinue = false, isSwipe = false, isGroup = false, isDryRun = false,
        canUseTools = false, quiet_prompt, quietToLoud = false, quietName,
        generationTrigger = GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
        name1 = '', name2 = '',
        directories, avatar, groupId, preferCharacterPrompt = false, preferCharacterJailbreak = false,
        personaDescription, chatMetadata = {}, chat, sentMessage = null, textareaText = '', userPromptBias = '',
        alwaysForceName2 = false, forceName2Override,
        reasoningAddToPrompts = false, reasoningMaxAdditions = 999999, reasoningPrefix = '', reasoningSeparator = '', reasoningSuffix = '',
        regexScripts = [], regexExtensionEnabled = true,
        tokenPadding = 0, countTokens, countPromptTokens = countTokens, encodeTokens, encodeTokensByType, novelTokenizerType, amountGen = 0, requestTokenProbabilities = false,
        chatGuidanceScale, groupchatIndividualChars = false, charaCfg, globalCfg, promptCombine = [], promptSeparator, promptInsertionDepth = 1, chatMetadataPrompts = {},
        worldInfoCandidates = [], worldInfoGlobals,
        entryFilterContext = {}, externalActivations = new Map(), worldInfoRandom = Math.random,
        noteSettings = {}, hasCharacterOrGroup = false,
        storyStringTemplate = '', storyStringPosition = 0, storyStringDepth = 1, storyStringRole = 0,
        sysPromptEnabled = false, sysPromptContent = '', personaDescriptionPosition = 0, stripExamples = false,
        personaDescriptionDepth = persona_description_defaults.depth, personaDescriptionRole = persona_description_defaults.role,
        beforeScenarioAnchor = '', afterScenarioAnchor = '',
        isInstruct = false, instructPreset = {}, contextSettings = {}, instructUserAlignmentMessage,
        instructWrap = false, pinExamples = false,
        sysPromptPostHistory = '', injectedIndices: initialInjectedIndices = [],
        mainApi, naiPreamble = '', chatStart = '', collapseNewlines = false,
        namesAsStopStrings = false, singleLine = false, customStoppingStringsRaw, customStoppingStringsMacro = false,
        ephemeralStoppingStrings = [], groupMemberNames = [], groupDisabledMembers = [],
        bannedTokensRaw = '', globalBannedTokensRaw = '', sendBannedTokens = false, logitBiasEntries = [],
        settings = {}, model,
        koboldFlags = {}, isHorde = false, apiServer, novelDataTier, presetOrder, consoleLogPrompts = false,
        macroFacts = {},
    } = input;

    if (typeof countTokens !== 'function') throw new Error('assembleTextCompletionPrompt: countTokens is required');
    if (typeof encodeTokens !== 'function') throw new Error('assembleTextCompletionPrompt: encodeTokens is required');
    if (mainApi === 'novel' && typeof encodeTokensByType !== 'function') throw new Error('assembleTextCompletionPrompt: encodeTokensByType is required for novel');
    if (mainApi === 'novel' && typeof novelTokenizerType !== 'number') throw new Error('assembleTextCompletionPrompt: novelTokenizerType is required for novel');

    const bannedWordsSink = [];

    const baseMacroContext = { ...macroFacts, name1, name2, isGroup, groupMembers: groupMemberNames, groupDisabledMembers, chat, chatMetadata, bannedWordsSink };
    const { messageBias, promptBias, isUserPromptBias } = getBiasStrings({
        textareaText, type, chat, userPromptBias, macroContext: baseMacroContext,
    });

    const fields = await getCharacterCardFields(directories, {
        avatar, groupId, preferCharacterPrompt, preferCharacterJailbreak, personaDescription, chatMetadata,
        macroContext: baseMacroContext,
    });

    const macroContext = {
        ...baseMacroContext,
        characterCard: {
            system: fields.system,
            jailbreak: fields.jailbreak,
            description: fields.description,
            personality: fields.personality,
            scenario: fields.scenario,
            persona: fields.persona,
            mesExamples: fields.mesExamples,
            mesExamplesRaw: fields.mesExamples,
            charVersion: fields.version,
            charDepthPrompt: fields.charDepthPrompt,
            creatorNotes: fields.creatorNotes,
        },
    };

    let coreChat = buildCoreChat(chat, { canUseTools, isSwipe });
    const scannedMessages = coreChat.map(m => ({ nodeId: m === sentMessage ? null : (m.node_id ?? ''), text: m.mes ?? '' })).reverse();

    const coreChatLengthForRegex = coreChat.length;
    coreChat = await Promise.all(coreChat.map(async (chatItem, index) => {
        const message = chatItem === chat[0] ? substituteParams(chatItem.mes ?? '', macroContext) : chatItem.mes;
        const regexType = chatItem.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
        const depth = coreChatLengthForRegex - index - (isContinue ? 2 : 1);
        const regexedMessage = getRegexedString(message, regexType, regexScripts, {
            isPrompt: true, depth, macroContext, regexExtensionEnabled,
        });
        const resolvedMessage = await appendFileAttachments(chatItem.extra, regexedMessage, { directories });
        return finalizeCoreChatMessage(chatItem, index, resolvedMessage);
    }));

    let reasoningState = createReasoningFoldState();
    const reasoningConfig = {
        addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions,
        reasoningPrefix, reasoningSeparator, reasoningSuffix, macroContext,
    };
    for (let i = coreChat.length - 1; i >= 0; i--) {
        const isPrefix = isContinue && i === coreChat.length - 1;
        const isOtherGroupMember = isGroup && coreChat[i].name !== name2;
        if (!isOtherGroupMember) {
            const reasoning = reasoningOf(coreChat[i].extra);
            const duration = coreChat[i].extra?.reasoning_duration ?? null;
            const reasoningDepth = coreChat.length - i - (isContinue ? 2 : 1);
            const regexedReasoning = reasoning === null ? null : getRegexedString(reasoning, regex_placement.REASONING, regexScripts, {
                isPrompt: true, depth: reasoningDepth, macroContext, regexExtensionEnabled,
            });
            const { content, state } = foldReasoningIntoMessage(reasoningState, coreChat[i].mes, regexedReasoning, isPrefix, duration, reasoningConfig);
            reasoningState = state;
            coreChat[i] = { ...coreChat[i], mes: content };
        }
        if (isReasoningLimitReached(reasoningState, { addToPrompts: reasoningAddToPrompts, maxAdditions: reasoningMaxAdditions })) {
            break;
        }
    }

    const cfgGuidanceScale = getGuidanceScale({ chatGuidanceScale, groupchatIndividualChars, isGroup, charaCfg, globalCfg });
    const { thisMaxContext, negativePrompt, positivePrompt } = await adjustMaxContextForCfg({
        cfgGuidanceScale, thisMaxContext: input.thisMaxContext, countTokens,
        chatMetadataPrompts, charaCfg, globalCfg, promptCombine, promptSeparator, promptInsertionDepth, macroContext,
    });

    const authorsNote = resolveAuthorsNote({ chatMetadata, noteSettings, chat, avatar, hasCharacterOrGroup });

    const chatForWI = coreChat.map(x => worldInfoGlobals.world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
    const decoratedCandidates = worldInfoCandidates.map(entry => {
        const [decorators, content] = parseDecorators(entry.content || '');
        return { ...entry, decorators, content };
    });
    const globalScanData = {
        personaDescription: fields.persona,
        characterDescription: fields.description,
        characterPersonality: fields.personality,
        characterDepthPrompt: fields.charDepthPrompt,
        scenario: fields.scenario,
        creatorNotes: fields.creatorNotes,
        trigger: generationTrigger,
    };
    const scanInjects = [
        ['quiet', quiet_prompt],
        ['note', authorsNote.disabled === false && authorsNote.scan ? authorsNote.value : ''],
    ].filter(([, text]) => Boolean(text));
    const additionalScanInjects = scanInjects.map(([, text]) => text);
    const { activatedEntries, trace } = await activateWorldInfoEntries(decoratedCandidates, chatForWI, {
        maxContext: thisMaxContext, globals: worldInfoGlobals,
        globalScanData, macroContext, countTokens, random: worldInfoRandom, chatMetadata, isDryRun,
        entryFilterContext, externalActivations, additionalScanInjects,
    });
    const activations = isDryRun || !directories ? null : await buildActivationRecord(trace, {
        messages: scannedMessages,
        injects: scanInjects.map(([label]) => label),
        books: (await userStore(directories)).lib.books,
    });
    const WI_DEFAULT_DEPTH = 4;
    const { worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries } =
        bucketActivatedEntries(activatedEntries, {
            resolveContent: (entry) => {
                const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? WI_DEFAULT_DEPTH) : null;
                return getRegexedString(entry.content, regex_placement.WORLD_INFO, regexScripts, {
                    depth: regexDepth, isMarkdown: false, isPrompt: true, macroContext, regexExtensionEnabled,
                });
            },
        });

    const extensionPromptTable = createExtensionPromptTable();
    addPageInjections(extensionPromptTable, input.pageInjections);
    addNoteAndPersona(extensionPromptTable, {
        authorsNote, anBefore, anAfter,
        personaDescription, personaDescriptionPosition, personaDescriptionDepth, personaDescriptionRole,
    });

    const resolvedBeforeScenarioAnchor = getExtensionPrompt(
        extensionPromptTable, { position: extension_prompt_types.BEFORE_PROMPT }, macroContext,
    ).trim();
    const resolvedAfterScenarioAnchor = getExtensionPrompt(
        extensionPromptTable, { position: extension_prompt_types.IN_PROMPT }, macroContext,
    ).trim();
    const effectiveBeforeScenarioAnchor = resolvedBeforeScenarioAnchor || beforeScenarioAnchor;
    const effectiveAfterScenarioAnchor = resolvedAfterScenarioAnchor || afterScenarioAnchor;

    let mesExamplesArray = exampleBlocks(fields.mesExamples, worldInfoExamples, {
        mainApi, isInstruct, exampleSeparator: contextSettings.example_separator, macroContext,
    });
    const mesExamplesRawArray = [...mesExamplesArray];

    if (isInstruct) {
        mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2, {
            instructPreset, contextSettings, isGroup, macroContext,
        });
    }

    const storyStringResult = assembleStoryString({
        description: fields.description, personality: fields.personality, persona: fields.persona, scenario: fields.scenario,
        system: fields.system, name1, name2, worldInfoBefore, worldInfoAfter,
        beforeScenarioAnchor: effectiveBeforeScenarioAnchor, afterScenarioAnchor: effectiveAfterScenarioAnchor,
        mesExamplesArray, mesExamplesRawArray, isInstruct, sysPromptEnabled, sysPromptContent, preferCharacterPrompt,
        personaDescriptionPosition, storyStringTemplate, storyStringPosition, storyStringDepth, storyStringRole,
        instructPreset, contextSettings, stripExamples, mainApi, macroContext,
    });
    const { system, combinedStoryString, storyStringInjection } = storyStringResult;
    mesExamplesArray = storyStringResult.mesExamplesArray;

    const groupCharacterDepthPrompts = isGroup && hasCharacterOrGroup
        ? await getGroupCharacterDepthPrompts(directories, groupId, avatar, baseMacroContext)
        : [];
    addDepthInjections(extensionPromptTable, {
        worldInfoDepthEntries, storyStringInjection, groupDepthPrompts: groupCharacterDepthPrompts,
        characterDepthPrompt: hasCharacterOrGroup ? { text: fields.charDepthPrompt || '', depth: fields.charDepthPromptDepth, role: fields.charDepthPromptRole } : null,
        depthPromptScan: noteSettings.allowWIScan,
    });

    const { coreChat: coreChatAfterDepthInjection, injectedIndices: doChatInjectIndices } = doChatInject(coreChat, isContinue, {
        name1, name2, table: extensionPromptTable, macroContext,
    });

    const effectiveInjectedIndices = initialInjectedIndices.length > 0 ? initialInjectedIndices : doChatInjectIndices;

    const { coreChat: coreChatWithJailbreak, injectedIndices: injectedIndicesAfterJailbreak, jailbreak } = injectJailbreak(
        coreChatAfterDepthInjection, effectiveInjectedIndices, {
            mainApi, sysPromptEnabled, jailbreak: fields.jailbreak, preferCharacterJailbreak, sysPromptPostHistory, isContinue, macroContext,
        },
    );

    const { chat2, userMessageIndices, userAlignmentMessage, addUserAlignment } = buildChat2(coreChatWithJailbreak, {
        isInstruct, isImpersonate, isContinue, instructPreset, name1, name2, isGroup, instructUserAlignmentMessage, macroContext,
    });

    const orForcesTrue = (promptBias && !isUserPromptBias) || alwaysForceName2 || mainApi === 'novel';
    const force_name2 = isImpersonate
        ? false
        : (orForcesTrue ? true : Boolean(forceName2Override));

    const modifyLastPromptLineParams = {
        quiet_prompt, name1, name2, isInstruct, quietToLoud, type, quietName, isImpersonate, promptBias,
        chat, force_name2, isContinue, isGroup, instructPreset, macroContext,
    };

    const pinExmString = pinExamples ? mesExamplesArray.join('') : undefined;
    const examplesString = pinExamples ? mesExamplesArray.join('') : '';
    const chatString = addChatsPreamble(addChatsSeparator('', { chatStart, macroContext }), { mainApi, naiPreamble, macroContext });

    async function computeBaselineTokenCount(cyclePromptValue) {
        const encodeString = [
            combinedStoryString, examplesString, userAlignmentMessage, chatString,
            modifyLastPromptLine('', modifyLastPromptLineParams), cyclePromptValue,
        ].join('').replace(/\r/gm, '');
        return (await countPromptTokens(encodeString)) + tokenPadding;
    }

    const baselineTokenCount1 = await computeBaselineTokenCount('');
    const { arrMes, injectedIndices: filledInjectedIndices, cyclePrompt } = await fillContextBudget({
        chat2, injectedIndices: injectedIndicesAfterJailbreak, userMessageIndices,
        thisMaxContext, baselineTokenCount: baselineTokenCount1, countTokens,
        userAlignmentMessage, addUserAlignment, isContinue,
    });

    const baselineTokenCount2 = await computeBaselineTokenCount(cyclePrompt);
    const { count_exm_add: initialCountExmAdd } = await estimateExampleBudget({
        mesExamplesArray, thisMaxContext, baselineTokenCount: baselineTokenCount2, countTokens, pinExamples,
    });

    const { mesSend: builtMesSend, generatedPromptCache } = buildMesSend({
        arrMes, cyclePrompt, type, isInstruct, instructWrap,
    });

    const { mesSend, mesExmString } = await resolvePromptStrings({
        mesSend: builtMesSend, mesExamplesArray, countExmAdd: initialCountExmAdd, pinExmString,
        combinedStoryString, generatedPromptCache, thisMaxContext, countTokens: countPromptTokens, mainApi, naiPreamble, chatStart,
        macroContext, modifyLastPromptLineParams,
    });

    const cfgPrompt = positivePrompt;

    const { combinedPrompt, finalMesSend, mesSendString } = combineFinalPrompt({
        mesSend, injectedIndices: filledInjectedIndices, cfgPrompt, promptBias, isInstruct, isImpersonate,
        combinedStoryString, mesExmString, generatedPromptCache, chatStart, mainApi, naiPreamble, collapseNewlines, macroContext,
    });

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
    const logitBias = isTextgen
        ? await calculateLogitBias({ logitBiasEntries, encode: encodeTokens, dropped: droppedEntries })
        : {};

    const cfgValues = { guidanceScale: cfgGuidanceScale, negativePrompt: negativePrompt?.value };
    let generate_data;
    if (mainApi === 'kobold') {
        generate_data = createKoboldGenerationData({
            finalPrompt: combinedPrompt,
            settings,
            maxLength: amountGen,
            maxContextLength: input.maxContext ?? input.thisMaxContext,
            isHorde,
            type,
            koboldSettings: settings,
            koboldFlags,
            apiServer,
            stoppingStringsParams,
            macroContext,
        });
    } else if (mainApi === 'novel') {
        generate_data = await createNovelGenerationData({
            finalPrompt: combinedPrompt,
            settings,
            maxLength: amountGen,
            isImpersonate,
            isContinue,
            type,
            novelDataTier,
            presetOrder,
            consoleLogPrompts,
            requestTokenProbabilities,
            stoppingStringsParams,
            tokenizerType: novelTokenizerType,
            encodeTokens: encodeTokensByType,
            dropped: droppedEntries,
            macroContext,
        });
    } else {
        generate_data = await createTextGenGenerationData(settings, model, combinedPrompt, amountGen, isImpersonate, isContinue, cfgValues, type, {
            stoppingStrings, bannedTokens, bannedStrings, logitBias, maxContext: thisMaxContext, requestTokenProbabilities, macroContext,
        });
    }

    return {
        combinedPrompt,
        generate_data,
        droppedEntries,
        messageBias, promptBias, isUserPromptBias,
        characterCardFields: fields,
        coreChat: coreChatWithJailbreak,
        thisMaxContext, negativePrompt, positivePrompt,
        worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth: worldInfoDepthEntries, anBefore, anAfter, outletEntries,
        activations,
        authorsNote,
        resolvedBeforeScenarioAnchor, resolvedAfterScenarioAnchor,
        system, combinedStoryString, storyStringInjection, mesExamplesArray, mesExamplesRawArray, examplesString,
        jailbreak,
        chat2, userMessageIndices, userAlignmentMessage, addUserAlignment,
        arrMes, cyclePrompt, generatedPromptCache,
        mesSend, mesExmString,
        finalMesSend, mesSendString,
        stoppingStrings, bannedTokens, bannedStrings, logitBias,
        doChatInjectIndices,
        gaps: {
            extensionPromptsSideTable: 'worldInfoDepth/storyStringInjection/characterDepthPrompt(single-character AND group-chat, via getGroupCharacterDepthPrompts()) ARE spliced into the chat array via doChatInject() (see module doc comment gap 1). authorsNote is now written at its REAL position (any of IN_CHAT/BEFORE_PROMPT/IN_PROMPT) - IN_CHAT is spliced via doChatInject(), BEFORE_PROMPT/IN_PROMPT is resolved into beforeScenarioAnchor/afterScenarioAnchor (now CLOSED, see resolvedBeforeScenarioAnchor/resolvedAfterScenarioAnchor above). outletEntries is still NOT wired into anything - still open.',
        },
    };
}

/**
 * @param {Awaited<ReturnType<typeof assembleTextCompletionPrompt>>} assembled
 * @returns {Record<string, *>}
 */
export function buildItemizationBreakdown(assembled) {
    return {
        storyString: assembled.combinedStoryString,
        worldInfoString: (assembled.worldInfoBefore || '') + (assembled.worldInfoAfter || ''),
        examplesString: assembled.examplesString || '',
        mesSendString: assembled.mesSendString,
        promptBias: assembled.promptBias,
        generatedPromptCache: assembled.generatedPromptCache,
        beforeScenarioAnchor: assembled.resolvedBeforeScenarioAnchor,
        afterScenarioAnchor: assembled.resolvedAfterScenarioAnchor,
        finalPrompt: assembled.combinedPrompt,
        rawPrompt: assembled.combinedPrompt,
    };
}
