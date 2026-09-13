import { substituteParams } from '../macro-substitution.js';

/** Mirrors public/scripts/utils.js's escapeRegex(). */
export function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mirrors public/scripts/world-info.js's parseRegexFromString(). */
export function parseRegexFromString(input) {
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null;
    pattern = pattern.replace('\\/', '/');
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

/**
 * Mirrors public/scripts/world-info.js's WorldInfoBuffer#matchKeys(). Regex keys (/pattern/flags)
 * override all other matching options.
 * @param {string} haystack
 * @param {string} needle
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} entry
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} globalDefaults
 * @returns {boolean}
 */
export function matchKeys(haystack, needle, entry, globalDefaults = {}) {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) return keyRegex.test(haystack);

    const caseSensitive = entry.caseSensitive ?? globalDefaults.caseSensitive ?? false;
    const transform = (str) => caseSensitive ? str : str.toLowerCase();
    haystack = transform(haystack);
    const transformedNeedle = transform(needle);
    const matchWholeWords = entry.matchWholeWords ?? globalDefaults.matchWholeWords ?? false;

    if (!matchWholeWords) return haystack.includes(transformedNeedle);

    const keyWords = transformedNeedle.split(/\s+/);
    if (keyWords.length > 1) return haystack.includes(transformedNeedle);

    const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedNeedle)})(?:$|\\W)`);
    return regex.test(haystack);
}

const MAX_SCAN_DEPTH = 1000;

/**
 * Server-side port of public/scripts/world-info.js's WorldInfoBuffer. Builds the depth-limited
 * chat text buffer an entry's keys get matched against.
 */
export class WorldInfoBuffer {
    #globalScanData;
    #depthBuffer = [];
    #recurseBuffer = [];
    #injectBuffer = [];
    #skew = 0;
    #startDepth = 0;
    #worldInfoDepth;
    #globalDefaults;

    /**
     * @param {string[]} messages Chat messages, most recent first (same order the client scans in)
     * @param {object} globalScanData {personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes}
     * @param {{depth?: number, caseSensitive?: boolean, matchWholeWords?: boolean}} [globalDefaults]
     */
    constructor(messages, globalScanData, globalDefaults = {}) {
        this.#globalDefaults = globalDefaults;
        this.#worldInfoDepth = globalDefaults.depth ?? 0;
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            if (messages[depth]) this.#depthBuffer[depth] = messages[depth].trim();
            if (depth === messages.length - 1) break;
        }
        this.#globalScanData = globalScanData ?? {};
    }

    get(entry, scanState, minActivationsState) {
        let depth = entry.scanDepth ?? this.getDepth();
        if (depth <= this.#startDepth) return '';
        if (depth < 0) return '';
        if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;

        const MATCHER = '\x01';
        const JOINER = '\n' + MATCHER;
        let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);

        const g = this.#globalScanData;
        if (entry.matchPersonaDescription && g.personaDescription) result += JOINER + g.personaDescription;
        if (entry.matchCharacterDescription && g.characterDescription) result += JOINER + g.characterDescription;
        if (entry.matchCharacterPersonality && g.characterPersonality) result += JOINER + g.characterPersonality;
        if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) result += JOINER + g.characterDepthPrompt;
        if (entry.matchScenario && g.scenario) result += JOINER + g.scenario;
        if (entry.matchCreatorNotes && g.creatorNotes) result += JOINER + g.creatorNotes;

        if (this.#injectBuffer.length > 0) result += JOINER + this.#injectBuffer.join(JOINER);
        if (this.#recurseBuffer.length > 0 && scanState !== minActivationsState) result += JOINER + this.#recurseBuffer.join(JOINER);

        return result;
    }

    matchKeys(haystack, needle, entry) {
        return matchKeys(haystack, needle, entry, this.#globalDefaults);
    }

    addRecurse(message) { this.#recurseBuffer.push(message); }
    addInject(message) { this.#injectBuffer.push(message); }
    hasRecurse() { return this.#recurseBuffer.length > 0; }
    advanceScan() { this.#skew++; }
    getDepth() { return this.#worldInfoDepth + this.#skew; }
}

/**
 * Mirrors the primary/secondary key check inside public/scripts/world-info.js's checkWorldInfo()
 * main loop, given an entry's already-fetched scan buffer text. Returns the matched primary key
 * string, or null if the entry doesn't activate on keys.
 * @param {string} textToScan
 * @param {object} entry {key, keysecondary, selective, selectiveLogic}
 * @param {WorldInfoBuffer} buffer
 * @param {{name1?: string, name2?: string}} [macroContext]
 * @returns {boolean}
 */
export function matchesEntryKeys(textToScan, entry, buffer, macroContext = {}) {
    if (!Array.isArray(entry.key) || !entry.key.length) return false;

    const primaryKeyMatch = entry.key.find(key => {
        const substituted = substituteParams(key, macroContext);
        return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
    });
    if (!primaryKeyMatch) return false;

    const hasSecondaryKeywords = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length;
    if (!hasSecondaryKeywords) return true;

    return matchSecondaryKeys(textToScan, entry, buffer, macroContext);
}

// world_info_logic enum values, mirrored from public/scripts/world-info.js.
export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

function matchSecondaryKeys(textToScan, entry, buffer, macroContext) {
    const selectiveLogic = entry.selectiveLogic ?? world_info_logic.AND_ANY;
    let hasAnyMatch = false;
    let hasAllMatch = true;

    for (const keysecondary of entry.keysecondary) {
        const substituted = substituteParams(keysecondary, macroContext);
        const hasMatch = substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
        if (hasMatch) hasAnyMatch = true;
        if (!hasMatch) hasAllMatch = false;

        if (selectiveLogic === world_info_logic.AND_ANY && hasMatch) return true;
        if (selectiveLogic === world_info_logic.NOT_ALL && !hasMatch) return true;
    }

    if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) return true;
    if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) return true;
    return false;
}
