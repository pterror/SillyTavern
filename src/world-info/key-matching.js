import { substituteParams } from '../macro-substitution.js';

export function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

export const MAX_SPANS = 32;

/**
 * @param {string} haystack
 * @param {string} needle
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} entry
 * @param {{caseSensitive?: boolean, matchWholeWords?: boolean}} [globalDefaults]
 * @returns {[number, number][]}
 */
export function findKeySpans(haystack, needle, entry, globalDefaults = {}) {
    /** @type {[number, number][]} */
    const spans = [];
    const keyRegex = parseRegexFromString(needle);
    let pattern;
    if (keyRegex) {
        pattern = new RegExp(keyRegex.source, keyRegex.flags.replace('g', '') + 'gd');
    } else {
        const caseSensitive = entry.caseSensitive ?? globalDefaults.caseSensitive ?? false;
        const matchWholeWords = entry.matchWholeWords ?? globalDefaults.matchWholeWords ?? false;
        const flags = caseSensitive ? 'gdu' : 'gdiu';
        if (!needle) return spans;
        const singleWord = needle.split(/\s+/).length === 1;
        pattern = matchWholeWords && singleWord
            ? new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?=$|\\W)`, flags)
            : new RegExp(`(${escapeRegex(needle)})`, flags);
    }
    for (const match of haystack.matchAll(pattern)) {
        const indices = /** @type {RegExpIndicesArray} */ (match.indices);
        const [from, to] = keyRegex ? indices[0] : indices[1];
        if (to > from) spans.push([from, to]);
        if (spans.length >= MAX_SPANS) break;
    }
    return spans;
}

const MAX_SCAN_DEPTH = 1000;

/** @typedef {{depth: number} | {field: string} | {inject: number} | {recurse: number}} ScanSource */

const GLOBAL_SCAN_FIELDS = /** @type {const} */ ([
    ['matchPersonaDescription', 'personaDescription'],
    ['matchCharacterDescription', 'characterDescription'],
    ['matchCharacterPersonality', 'characterPersonality'],
    ['matchCharacterDepthPrompt', 'characterDepthPrompt'],
    ['matchScenario', 'scenario'],
    ['matchCreatorNotes', 'creatorNotes'],
]);

export const scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 };

export class WorldInfoBuffer {
    #globalScanData;
    #depthBuffer = [];
    #recurseBuffer = [];
    #injectBuffer = [];
    #skew = 0;
    #startDepth = 0;
    #worldInfoDepth;
    #globalDefaults;
    #externalActivations;

    /**
     * @param {string[]} messages
     * @param {object} globalScanData
     * @param {{depth?: number, caseSensitive?: boolean, matchWholeWords?: boolean}} [globalDefaults]
     * @param {Map<string, object>} [externalActivations]
     */
    constructor(messages, globalScanData, globalDefaults = {}, externalActivations = new Map()) {
        this.#globalDefaults = globalDefaults;
        this.#worldInfoDepth = globalDefaults.depth ?? 0;
        for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
            if (messages[depth]) this.#depthBuffer[depth] = messages[depth].trim();
            if (depth === messages.length - 1) break;
        }
        this.#globalScanData = globalScanData ?? {};
        this.#externalActivations = externalActivations;
    }

    getExternallyActivated(entry) {
        return this.#externalActivations.get(`${entry.world}.${entry.uid}`);
    }

    get(entry, scanState) {
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
        if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) result += JOINER + this.#recurseBuffer.join(JOINER);

        return result;
    }

    /**
     * @param {object} entry
     * @param {number} scanState
     * @returns {{source: ScanSource, text: string}[]}
     */
    sources(entry, scanState) {
        /** @type {{source: ScanSource, text: string}[]} */
        const out = [];
        let depth = entry.scanDepth ?? this.getDepth();
        if (depth <= this.#startDepth || depth < 0) return out;
        if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;
        for (let d = this.#startDepth; d < depth; d++) {
            if (this.#depthBuffer[d] !== undefined) out.push({ source: { depth: d }, text: this.#depthBuffer[d] });
        }
        const g = this.#globalScanData;
        for (const [flag, field] of GLOBAL_SCAN_FIELDS) {
            if (entry[flag] && g[field]) out.push({ source: { field }, text: g[field] });
        }
        this.#injectBuffer.forEach((text, inject) => out.push({ source: { inject }, text }));
        if (scanState !== scan_state.MIN_ACTIVATIONS) {
            this.#recurseBuffer.forEach((text, recurse) => out.push({ source: { recurse }, text }));
        }
        return out;
    }

    getScore(entry, scanState) {
        const bufferState = this.get(entry, scanState);
        let numberOfPrimaryKeys = 0;
        let numberOfSecondaryKeys = 0;
        let primaryScore = 0;
        let secondaryScore = 0;

        if (Array.isArray(entry.key)) {
            numberOfPrimaryKeys = entry.key.length;
            for (const key of entry.key) {
                if (this.matchKeys(bufferState, key, entry)) primaryScore++;
            }
        }

        if (Array.isArray(entry.keysecondary)) {
            numberOfSecondaryKeys = entry.keysecondary.length;
            for (const key of entry.keysecondary) {
                if (this.matchKeys(bufferState, key, entry)) secondaryScore++;
            }
        }

        if (!numberOfPrimaryKeys) return 0;

        if (numberOfSecondaryKeys > 0) {
            switch (entry.selectiveLogic) {
                case world_info_logic.AND_ANY:
                    return primaryScore + secondaryScore;
                case world_info_logic.AND_ALL:
                    return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
            }
        }

        return primaryScore;
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
 * @param {string} textToScan
 * @param {object} entry
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

export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

/**
 * @param {object} entry
 * @param {WorldInfoBuffer} buffer
 * @param {number} scanState
 * @param {{name1?: string, name2?: string}} [macroContext]
 * @returns {{key: string, sources: ScanSource[]}[]}
 */
export function matchedKeys(entry, buffer, scanState, macroContext = {}) {
    const sources = buffer.sources(entry, scanState);
    const logic = entry.selectiveLogic ?? world_info_logic.AND_ANY;
    const secondaryCounts = entry.selective && (logic === world_info_logic.AND_ANY || logic === world_info_logic.AND_ALL);
    const keys = [...(entry.key ?? []), ...(secondaryCounts ? entry.keysecondary ?? [] : [])];
    /** @type {{key: string, sources: ScanSource[]}[]} */
    const out = [];
    for (const raw of keys) {
        const key = substituteParams(raw, macroContext)?.trim();
        if (!key) continue;
        const where = sources.filter(s => buffer.matchKeys(s.text, key, entry)).map(s => s.source);
        if (where.length) out.push({ key, sources: where });
    }
    return out;
}

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
