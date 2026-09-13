import { WorldInfoBuffer, matchesEntryKeys, scan_state } from './key-matching.js';
import { verifyProbability } from './probability.js';
import { WorldInfoTimedEffects } from './timed-effects.js';
import { filterByInclusionGroups } from './inclusion-groups.js';
import { passesEntryFilters } from './entry-filters.js';
import { getDecoratorActivation } from './decorators.js';
import { substituteParams } from '../macro-substitution.js';

/**
 * Server-side port of the CORE of public/scripts/world-info.js's checkWorldInfo() - primary/
 * secondary key matching, constant entries, probability, sticky/cooldown/delay timed effects,
 * inclusion groups, character/tag/generation-trigger filters, @@activate/@@dont_activate
 * decorators, externally-forced activations, recursion via matched-entry content, min-activations
 * depth-advancing, and token-budget enforcement. Uses the real scan_state machine
 * (INITIAL/RECURSION/MIN_ACTIVATIONS/NONE), not a simplified first-pass/later-pass boolean - that
 * distinction matters for real behavior (e.g. excludeRecursion is only honored during an actual
 * RECURSION pass, not a MIN_ACTIVATIONS one). Reduced scope, explicitly NOT ported:
 * delay-until-recursion levels. Every entry is treated as always eligible on that axis - a caller
 * needing it must pre-filter `entries` or post-process the result themselves for now.
 *
 * Decorators: unlike the other WIEntry fields below, `decorators` is NOT parsed here - the client's
 * getSortedEntries() parses each entry's raw content with parseDecorators() (decorators.js) exactly
 * once, before checkWorldInfo's main loop ever runs, and strips the decorator lines out of the
 * content that gets scanned/activated. Callers of this module must do the same: call
 * parseDecorators(entry.content) for each entry, then pass the parsed `entry.decorators` array and
 * the decorator-stripped content in `entries` - this function only reads entry.decorators, it never
 * derives it from entry.content itself.
 *
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
 * @property {string[]} [decorators] Pre-parsed via parseDecorators() - see module doc comment above
 * @property {boolean} [useProbability]
 * @property {number} [probability]
 * @property {boolean} [ignoreBudget]
 * @property {boolean} [preventRecursion]
 * @property {boolean} [excludeRecursion]
 * @property {number} [scanDepth]
 * @property {boolean} [caseSensitive]
 * @property {boolean} [matchWholeWords]
 */

/**
 * @param {WIEntry[]} entries All candidate entries, in priority order (highest priority first)
 * @param {string[]} chatMessages Chat text, most recent first
 * @param {object} options
 * @param {number} options.maxContext
 * @param {number} options.budgetPercent world_info_budget setting (0-100)
 * @param {number} [options.budgetCap] world_info_budget_cap setting (0 = no cap)
 * @param {number} [options.depth] world_info_depth setting
 * @param {boolean} [options.recursive] world_info_recursive setting
 * @param {number} [options.maxRecursionSteps] world_info_max_recursion_steps setting (0 = unlimited, capped internally at 25 as a safety net)
 * @param {object} [options.globalScanData] {personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes}
 * @param {{name1?: string, name2?: string}} [options.macroContext]
 * @param {(text: string) => Promise<number>} options.countTokens Injected tokenizer - no server tokenizer access is assumed here
 * @param {() => number} [options.random] Injectable RNG for tests
 * @param {object} [options.chatMetadata] Mutable chat metadata - timedWorldInfo is read/written on it directly (see WorldInfoTimedEffects)
 * @param {boolean} [options.isDryRun] Skips sticky/cooldown state changes (delay is still evaluated) - same as checkWorldInfo's dry-run mode
 * @param {boolean} [options.useGroupScoring] world_info_use_group_scoring setting
 * @param {{trigger?: string, characterFilename?: string, characterTags?: string[]}} [options.entryFilterContext] Generation-trigger and character/tag filter inputs (see entry-filters.js)
 * @param {number} [options.minActivations] world_info_min_activations setting (0 = disabled) - keep scanning deeper into chat history until at least this many entries have activated
 * @param {number} [options.minActivationsDepthMax] world_info_min_activations_depth_max setting (0 = no extra cap beyond chat length)
 * @param {Map<string, WIEntry>} [options.externalActivations] Entries to force-activate regardless of key matching, keyed by `${world}.${uid}` - mirrors the client's WORLDINFO_FORCE_ACTIVATE event; no event system here, the caller resolves and passes these in directly
 * @returns {Promise<{activatedEntries: WIEntry[], content: string}>}
 */
export async function activateWorldInfoEntries(entries, chatMessages, options) {
    const {
        maxContext, budgetPercent, budgetCap = 0, depth = 0, recursive = true,
        maxRecursionStepsSetting = 0, globalScanData = {}, macroContext = {}, countTokens, random = Math.random,
        chatMetadata = {}, isDryRun = false, useGroupScoring = false, entryFilterContext = {},
        minActivations = 0, minActivationsDepthMax = 0, externalActivations = new Map(),
    } = options;
    const maxRecursionSteps = maxRecursionStepsSetting > 0 ? maxRecursionStepsSetting : 25;

    let budget = Math.round(budgetPercent * maxContext / 100) || 1;
    if (budgetCap > 0 && budget > budgetCap) budget = budgetCap;

    const candidateEntries = entries.filter(e => !e.disable);
    if (candidateEntries.length === 0) return { activatedEntries: [], content: '' };

    const buffer = new WorldInfoBuffer(chatMessages, globalScanData, { depth }, externalActivations);
    const timedEffects = new WorldInfoTimedEffects(chatMessages, candidateEntries, chatMetadata, isDryRun);
    timedEffects.checkTimedEffects();

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
            // excludeRecursion only applies to an actual recursion pass, not a min-activations one.
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
        // Computed once per pass, not per entry - activatedText doesn't change within a pass, so
        // recomputing this per entry would be N redundant tokenizer calls for the same answer.
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

        // A min-activations pass that turned up recursable content needs one recursion pass before
        // advancing depth again - there might be recursion-triggerable entries matching what was
        // just added to the buffer.
        if (recursive && !tokenBudgetOverflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse()) {
            nextScanState = scan_state.RECURSION;
        }

        // If nothing else wants to continue the scan, but min-activations isn't satisfied yet, keep
        // advancing depth (independent of the `recursive` setting - min-activations is about scanning
        // further back in chat history, not about recursing through matched content).
        const minActivationsNotSatisfied = minActivations > 0 && activated.size < minActivations;
        if (!nextScanState && !tokenBudgetOverflowed && minActivationsNotSatisfied) {
            const overMax = (minActivationsDepthMax > 0 && buffer.getDepth() > minActivationsDepthMax) || (buffer.getDepth() > chatMessages.length);
            if (!overMax) {
                nextScanState = scan_state.MIN_ACTIVATIONS;
                buffer.advanceScan();
            }
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
