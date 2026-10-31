import { baseChatReplace, substituteParams } from './macro-substitution.js';
import { wi_anchor_position } from './world-info/result-bucketing.js';

/**
 * @param {string} examplesStr
 * @param {{ mainApi?: string, isInstruct?: boolean, exampleSeparator?: string, macroContext?: import('./macro-substitution.js').SubstituteParamsContext }} options
 * @returns {string[]}
 */
export function parseMesExamples(examplesStr, { mainApi, isInstruct = false, exampleSeparator = '', macroContext = {} } = {}) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') {
        return [];
    }
    if (!examplesStr.startsWith('<START>')) {
        examplesStr = '<START>\n' + examplesStr.trim();
    }
    const separatorBlock = exampleSeparator ? `${substituteParams(exampleSeparator, macroContext)}\n` : '';
    const blockHeading = mainApi === 'openai' || isInstruct ? '<START>\n' : separatorBlock;
    return examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
}

/**
 * @param {string} mesExamples
 * @param {{ content: string, position: number }[]} worldInfoExamples
 * @param {Parameters<typeof parseMesExamples>[1]} options
 * @returns {string[]}
 */
export function exampleBlocks(mesExamples, worldInfoExamples, options = {}) {
    const blocks = parseMesExamples(mesExamples, options);
    for (const example of worldInfoExamples) {
        if (!example.content || example.content.length === 0) continue;
        const entryBlocks = parseMesExamples(baseChatReplace(example.content, options.macroContext ?? {}), options);
        if (example.position === wi_anchor_position.before) {
            blocks.unshift(...entryBlocks);
        } else {
            blocks.push(...entryBlocks);
        }
    }
    return blocks;
}
