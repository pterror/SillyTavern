import { WorldInfoBuffer, matchesEntryKeys, scan_state } from './key-matching.js';
import { verifyProbability } from './probability.js';
import { WorldInfoTimedEffects } from './timed-effects.js';
import { filterByInclusionGroups } from './inclusion-groups.js';
import { passesEntryFilters } from './entry-filters.js';
import { getDecoratorActivation } from './decorators.js';
import { substituteParams } from '../macro-substitution.js';

/**
 * @typedef {object} WIEntry
 * @property {string} uid
 * @property {string} world
 * @property {string[]} key
 * @property {string[]} [keysecondary]
 * @property {boolean} [selective]
 * @property {number} [selectiveLogic]
 * @property {boolean} [constant]
 * @property {boolean} [disable]
 * @property {string} content
 * @property {string[]} [decorators]
 * @property {boolean} [useProbability]
 * @property {number} [probability]
 * @property {boolean} [ignoreBudget]
 * @property {boolean} [preventRecursion]
 * @property {boolean} [excludeRecursion]
 * @property {boolean|number} [delayUntilRecursion]
 * @property {number} [scanDepth]
 * @property {boolean} [caseSensitive]
 * @property {boolean} [matchWholeWords]
 */

/**
 * @param {WIEntry[]} entries
 * @param {string[]} chatMessages
 * @param {object} options
 * @param {number} options.maxContext
 * @param {number} options.budgetPercent
 * @param {number} [options.budgetCap]
 * @param {number} [options.depth]
 * @param {boolean} [options.recursive]
 * @param {number} [options.maxRecursionSteps]
 * @param {object} [options.globalScanData]
 * @param {{name1?: string, name2?: string}} [options.macroContext]
 * @param {(text: string) => Promise<number>} options.countTokens
 * @param {() => number} [options.random]
 * @param {object} [options.chatMetadata]
 * @param {boolean} [options.isDryRun]
 * @param {boolean} [options.useGroupScoring]
 * @param {{trigger?: string, characterFilename?: string, characterTags?: string[]}} [options.entryFilterContext]
 * @param {number} [options.minActivations]
 * @param {number} [options.minActivationsDepthMax]
 * @param {Map<string, WIEntry>} [options.externalActivations]
 * @param {string[]} [options.additionalScanInjects]
 * @returns {Promise<{activatedEntries: WIEntry[], content: string}>}
 */
export async function activateWorldInfoEntries(entries, chatMessages, options) {
    const {
        maxContext, budgetPercent, budgetCap = 0, depth = 0, recursive = true,
        maxRecursionStepsSetting = 0, globalScanData = {}, macroContext = {}, countTokens, random = Math.random,
        chatMetadata = {}, isDryRun = false, useGroupScoring = false, entryFilterContext = {},
        minActivations = 0, minActivationsDepthMax = 0, externalActivations = new Map(),
        additionalScanInjects = [],
    } = options;
    const maxRecursionSteps = maxRecursionStepsSetting > 0 ? maxRecursionStepsSetting : 25;

    let budget = Math.round(budgetPercent * maxContext / 100) || 1;
    if (budgetCap > 0 && budget > budgetCap) budget = budgetCap;

    const candidateEntries = entries.filter(e => !e.disable);
    if (candidateEntries.length === 0) return { activatedEntries: [], content: '' };

    const buffer = new WorldInfoBuffer(chatMessages, globalScanData, { depth }, externalActivations);
    for (const text of additionalScanInjects) {
        if (text) buffer.addInject(text);
    }
    const timedEffects = new WorldInfoTimedEffects(chatMessages, candidateEntries, chatMetadata, isDryRun);
    timedEffects.checkTimedEffects();

    const availableRecursionDelayLevels = [...new Set(candidateEntries
        .filter(entry => entry.delayUntilRecursion)
        .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion),
    )].sort((a, b) => a - b);
    let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;

    const activated = new Map();
    const failedProbability = new Set();
    let tokenBudgetOverflowed = false;
    let activatedText = '';
    let scanState = scan_state.INITIAL;
    let step = 0;

    while (scanState && step < maxRecursionSteps) {
        step++;
        const activatedNow = [];

        for (const entry of candidateEntries) {
            if (failedProbability.has(entry) || activated.has(`${entry.world}.${entry.uid}`)) continue;
            if (!passesEntryFilters(entry, entryFilterContext)) continue;

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            const isCooldown = timedEffects.isEffectActive('cooldown', entry);
            const isDelay = timedEffects.isEffectActive('delay', entry);

            if (isDelay) continue;
            if (isCooldown && !isSticky) continue;
            if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) continue;
            if (scanState === scan_state.RECURSION && entry.delayUntilRecursion && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky) continue;
            if (scanState === scan_state.RECURSION && recursive && entry.excludeRecursion && !isSticky) continue;

            const decoratorActivation = getDecoratorActivation(entry.decorators);
            if (decoratorActivation === 'activate') {
                activatedNow.push(entry);
                continue;
            }
            if (decoratorActivation === 'suppress') continue;

            const externallyActivated = buffer.getExternallyActivated(entry);
            if (externallyActivated) {
                activatedNow.push(externallyActivated);
                continue;
            }

            if (entry.constant) {
                activatedNow.push(entry);
                continue;
            }

            if (isSticky) {
                activatedNow.push(entry);
                continue;
            }

            const textToScan = buffer.get(entry, scanState);
            if (matchesEntryKeys(textToScan, entry, buffer, macroContext)) {
                activatedNow.push(entry);
            }
        }

        let newContent = '';
        const scanTokens = await countTokens(activatedText);
        filterByInclusionGroups(activatedNow, activated, buffer, scanState, timedEffects, { useGroupScoring, random });
        for (const entry of activatedNow) {
            if (tokenBudgetOverflowed && !entry.ignoreBudget) continue;

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            if (!verifyProbability(entry, isSticky, random)) {
                failedProbability.add(entry);
                continue;
            }

            entry.content = substituteParams(entry.content, macroContext);
            newContent += `${entry.content}\n`;

            if (!entry.ignoreBudget) {
                const contentTokens = await countTokens(newContent);
                if (scanTokens + contentTokens >= budget) {
                    tokenBudgetOverflowed = true;
                    continue;
                }
            }

            activated.set(`${entry.world}.${entry.uid}`, entry);
        }

        const successfulForRecursion = activatedNow.filter(e => activated.has(`${e.world}.${e.uid}`) && !e.preventRecursion);

        let nextScanState = scan_state.NONE;

        if (recursive && !tokenBudgetOverflowed && successfulForRecursion.length) {
            nextScanState = scan_state.RECURSION;
        }

        if (recursive && !tokenBudgetOverflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
            nextScanState = scan_state.RECURSION;
        }

        const minActivationsNotSatisfied = minActivations > 0 && activated.size < minActivations;
        if (!nextScanState && !tokenBudgetOverflowed && minActivationsNotSatisfied) {
            const overMax = (minActivationsDepthMax > 0 && buffer.getDepth() > minActivationsDepthMax) || (buffer.getDepth() > chatMessages.length);
            if (!overMax) {
                nextScanState = scan_state.MIN_ACTIVATIONS;
                buffer.advanceScan();
            }
        }

        if (!nextScanState && availableRecursionDelayLevels.length) {
            nextScanState = scan_state.RECURSION;
            currentRecursionDelayLevel = availableRecursionDelayLevels.shift();
        }

        scanState = nextScanState;
        if (scanState) {
            const text = successfulForRecursion.map(x => x.content).join('\n');
            if (text) {
                buffer.addRecurse(text);
                activatedText = text + '\n' + activatedText;
            }
        }
    }

    const activatedEntries = [...activated.values()];
    timedEffects.setTimedEffects(activatedEntries);
    timedEffects.cleanUp();

    const content = activatedEntries.map(e => e.content).join('\n');
    return { activatedEntries, content };
}
