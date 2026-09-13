import { WorldInfoBuffer, matchesEntryKeys } from './key-matching.js';
import { verifyProbability } from './probability.js';
import { substituteParams } from '../macro-substitution.js';

/**
 * Server-side port of the CORE of public/scripts/world-info.js's checkWorldInfo() - primary/
 * secondary key matching, constant entries, probability, recursion via matched-entry content, and
 * token-budget enforcement. Reduced scope, explicitly NOT ported:
 * sticky/cooldown/delay timed effects, delay-until-recursion levels, inclusion groups,
 * min-activations, character/tag/generation-trigger filters, @@activate/@@dont_activate
 * decorators, externally-forced activations. Every entry is treated as always eligible on those
 * axes (never sticky/cooldown/delayed, no inclusion-group exclusivity, no decorators) - a caller
 * needing those must pre-filter `entries` or post-process the result themselves for now.
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
 * @returns {Promise<{activatedEntries: WIEntry[], content: string}>}
 */
export async function activateWorldInfoEntries(entries, chatMessages, options) {
    const {
        maxContext, budgetPercent, budgetCap = 0, depth = 0, recursive = true,
        maxRecursionStepsSetting = 0, globalScanData = {}, macroContext = {}, countTokens, random = Math.random,
    } = options;
    const maxRecursionSteps = maxRecursionStepsSetting > 0 ? maxRecursionStepsSetting : 25;

    let budget = Math.round(budgetPercent * maxContext / 100) || 1;
    if (budgetCap > 0 && budget > budgetCap) budget = budgetCap;

    const candidateEntries = entries.filter(e => !e.disable);
    if (candidateEntries.length === 0) return { activatedEntries: [], content: '' };

    const buffer = new WorldInfoBuffer(chatMessages, globalScanData, { depth });

    const activated = new Map();
    const failedProbability = new Set();
    let tokenBudgetOverflowed = false;
    let activatedText = '';
    let isFirstPass = true;
    let step = 0;

    while (step < maxRecursionSteps) {
        step++;
        const activatedNow = [];

        for (const entry of candidateEntries) {
            if (failedProbability.has(entry) || activated.has(`${entry.world}.${entry.uid}`)) continue;

            if (!isFirstPass && !recursive) break;
            if (!isFirstPass && entry.excludeRecursion) continue;

            if (entry.constant) {
                activatedNow.push(entry);
                continue;
            }

            const textToScan = buffer.get(entry, isFirstPass ? 'initial' : 'recursion', 'min_activations');
            if (matchesEntryKeys(textToScan, entry, buffer, macroContext)) {
                activatedNow.push(entry);
            }
        }

        if (activatedNow.length === 0) break;

        let newContent = '';
        // Computed once per pass, not per entry - activatedText doesn't change within a pass, so
        // recomputing this per entry would be N redundant tokenizer calls for the same answer.
        const scanTokens = await countTokens(activatedText);
        for (const entry of activatedNow) {
            if (tokenBudgetOverflowed && !entry.ignoreBudget) continue;

            const isSticky = false; // timed effects not ported - see module doc comment
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
        if (successfulForRecursion.length === 0) break;

        for (const entry of successfulForRecursion) {
            buffer.addRecurse(entry.content);
            activatedText += entry.content + '\n';
        }

        isFirstPass = false;
        if (!recursive) break;
    }

    const activatedEntries = [...activated.values()];
    const content = activatedEntries.map(e => e.content).join('\n');
    return { activatedEntries, content };
}
