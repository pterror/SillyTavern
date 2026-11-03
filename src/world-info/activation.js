import { WorldInfoBuffer, findKeySpans, matchDefaultsOf, matchedKeys, matchesEntryKeys, scan_state } from './key-matching.js';
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
 * @typedef {'always' | 'sticky' | 'decorator' | 'key'} ActivationWhy
 * @typedef {{
 *   entry: WIEntry,
 *   why: ActivationWhy,
 *   step: number,
 *   keys: {key: string, sources: import('./key-matching.js').ScanSource[]}[],
 *   via: WIEntry[],
 * }} ActivatedTrace
 * @typedef {{ entry: WIEntry, why: 'budget' | 'chance' | 'group' }} CutTrace
 * @typedef {{ activated: ActivatedTrace[], cut: CutTrace[], defaults: import('./key-matching.js').MatchDefaults }} ActivationTrace
 */

/**
 * @param {{key: string, sources: import('./key-matching.js').ScanSource[]}[]} keys
 * @param {{entry: WIEntry, from: number, to: number}[][]} recurseParts
 * @param {string[]} recurseTexts
 * @param {WIEntry} entry
 * @param {import('./key-matching.js').MatchDefaults} defaults
 * @returns {WIEntry[]}
 */
function viaOf(keys, recurseParts, recurseTexts, entry, defaults) {
    /** @type {Set<WIEntry>} */
    const via = new Set();
    for (const { key, sources } of keys) {
        for (const source of sources) {
            if (!('recurse' in source)) continue;
            const parts = recurseParts[source.recurse] ?? [];
            for (const [from] of findKeySpans(recurseTexts[source.recurse] ?? '', key, entry, defaults)) {
                const part = parts.find(p => from >= p.from && from < p.to);
                if (part && part.entry !== entry) via.add(part.entry);
            }
        }
    }
    return [...via];
}

/**
 * @param {WIEntry[]} entries
 * @param {string[]} chatMessages
 * @param {object} options
 * @param {number} options.maxContext
 * @param {import('../../public/scripts/world-info-globals.js').WorldInfoGlobals} options.globals
 * @param {object} [options.globalScanData]
 * @param {{name1?: string, name2?: string}} [options.macroContext]
 * @param {(text: string) => Promise<number>} options.countTokens
 * @param {() => number} [options.random]
 * @param {object} [options.chatMetadata]
 * @param {boolean} [options.isDryRun]
 * @param {{trigger?: string, characterFilename?: string, characterTags?: string[]}} [options.entryFilterContext]
 * @param {string[]} [options.additionalScanInjects]
 * @returns {Promise<{activatedEntries: WIEntry[], content: string, trace: ActivationTrace}>}
 */
export async function activateWorldInfoEntries(entries, chatMessages, options) {
    const {
        maxContext, globals, globalScanData = {}, macroContext = {}, countTokens, random = Math.random,
        chatMetadata = {}, isDryRun = false, entryFilterContext = {},
        additionalScanInjects = [],
    } = options;
    const recursive = globals.world_info_recursive;
    const useGroupScoring = globals.world_info_use_group_scoring;
    const minActivations = globals.world_info_min_activations;
    const minActivationsDepthMax = globals.world_info_min_activations_depth_max;
    const maxRecursionSteps = globals.world_info_max_recursion_steps > 0 ? globals.world_info_max_recursion_steps : 25;

    let budget = Math.round(globals.world_info_budget * maxContext / 100) || 1;
    if (globals.world_info_budget_cap > 0 && budget > globals.world_info_budget_cap) budget = globals.world_info_budget_cap;

    const candidateEntries = entries.filter(e => !e.disable);
    /** @type {ActivationTrace} */
    const trace = { activated: [], cut: [], defaults: matchDefaultsOf(globals) };
    if (candidateEntries.length === 0) return { activatedEntries: [], content: '', trace };

    const buffer = new WorldInfoBuffer(chatMessages, globalScanData, globals);
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
    /** @type {Map<WIEntry, {why: ActivationWhy, keys: {key: string, sources: import('./key-matching.js').ScanSource[]}[]}>} */
    const why = new Map();
    /** @type {Map<WIEntry, CutTrace['why']>} */
    const cut = new Map();
    /** @type {{entry: WIEntry, from: number, to: number}[][]} */
    const recurseParts = [];
    /** @type {string[]} */
    const recurseTexts = [];
    /** @type {Map<WIEntry, number>} */
    const stepOf = new Map();

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
                why.set(entry, { why: 'decorator', keys: [] });
                continue;
            }
            if (decoratorActivation === 'suppress') continue;

            if (entry.constant) {
                activatedNow.push(entry);
                why.set(entry, { why: 'always', keys: [] });
                continue;
            }

            if (isSticky) {
                activatedNow.push(entry);
                why.set(entry, { why: 'sticky', keys: [] });
                continue;
            }

            const textToScan = buffer.get(entry, scanState);
            if (matchesEntryKeys(textToScan, entry, buffer, macroContext)) {
                activatedNow.push(entry);
                why.set(entry, { why: 'key', keys: matchedKeys(entry, buffer, scanState, macroContext) });
            }
        }

        let newContent = '';
        const scanTokens = await countTokens(activatedText);
        const beforeGroups = [...activatedNow];
        filterByInclusionGroups(activatedNow, activated, buffer, scanState, timedEffects, { useGroupScoring, random });
        for (const entry of beforeGroups) {
            if (!activatedNow.includes(entry)) cut.set(entry, 'group');
        }
        for (const entry of activatedNow) {
            if (tokenBudgetOverflowed && !entry.ignoreBudget) {
                cut.set(entry, 'budget');
                continue;
            }

            const isSticky = timedEffects.isEffectActive('sticky', entry);
            if (!verifyProbability(entry, isSticky, random)) {
                failedProbability.add(entry);
                cut.set(entry, 'chance');
                continue;
            }

            entry.content = substituteParams(entry.content, macroContext);
            newContent += `${entry.content}\n`;

            if (!entry.ignoreBudget) {
                const contentTokens = await countTokens(newContent);
                if (scanTokens + contentTokens >= budget) {
                    tokenBudgetOverflowed = true;
                    cut.set(entry, 'budget');
                    continue;
                }
            }

            activated.set(`${entry.world}.${entry.uid}`, entry);
            stepOf.set(entry, step);
            cut.delete(entry);
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
                /** @type {{entry: WIEntry, from: number, to: number}[]} */
                const parts = [];
                let at = 0;
                for (const x of successfulForRecursion) {
                    parts.push({ entry: x, from: at, to: at + x.content.length });
                    at += x.content.length + 1;
                }
                recurseParts.push(parts);
                recurseTexts.push(text);
                buffer.addRecurse(text);
                activatedText = text + '\n' + activatedText;
            }
        }
    }

    const activatedEntries = [...activated.values()];
    timedEffects.setTimedEffects(activatedEntries);
    timedEffects.cleanUp();

    const content = activatedEntries.map(e => e.content).join('\n');
    for (const entry of activatedEntries) {
        const found = why.get(entry) ?? { why: 'key', keys: [] };
        trace.activated.push({
            entry, why: found.why, step: stepOf.get(entry) ?? 1, keys: found.keys,
            via: viaOf(found.keys, recurseParts, recurseTexts, entry, buffer.matchDefaults),
        });
    }
    for (const [entry, reason] of cut) {
        if (!activated.has(`${entry.world}.${entry.uid}`)) trace.cut.push({ entry, why: reason });
    }
    return { activatedEntries, content, trace };
}
