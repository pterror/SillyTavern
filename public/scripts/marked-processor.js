import { Marked } from '../lib.js';

// No power-user.js or script.js imports here on purpose: both transitively import
// every consumer of this module (message-formatting.js, chats.js,
// SlashCommandReturnHelper.js), so importing power_user/substituteParams from them
// would create a cycle. Callers that already have the real values inject them instead
// (see reloadMarkedProcessor).
const identitySubstitute = (text) => text;

const EXCLUSION_MARKER = '​';

/**
 * @param {string} [escapeStrings] Comma-separated literal strings (power_user.markdown_escape_strings) to protect from markdown parsing.
 * @param {(text: string) => string} [substituteParamsFn] Macro-substitution function applied to escapeStrings before use (defaults to no substitution).
 * @returns {import('marked').MarkedExtension}
 */
export function markdownExclusionExt(escapeStrings, substituteParamsFn = identitySubstitute) {
    if (!escapeStrings) {
        return {};
    }

    return {
        hooks: {
            preprocess(markdown) {
                const escapedExclusions = substituteParamsFn(escapeStrings)
                    .split(',')
                    .filter((element) => element.length > 0)
                    .map((element) => `(${element.split('').map((char) => `\\${char}`).join('')})`);

                if (escapedExclusions.length === 0) {
                    return markdown;
                }

                const excludeRegex = new RegExp(`^(${escapedExclusions.join('|')})$`, 'gm');
                return markdown.replace(excludeRegex, (match) => `${EXCLUSION_MARKER}${match}`);
            },
            postprocess(html) {
                return html.split(EXCLUSION_MARKER).join('');
            },
        },
    };
}

export let markedProcessor = new Marked();

/** Same configuration as {@link markedProcessor}, except raw HTML tokens are shown as literal text. */
let markedLiteralTagsProcessor = new Marked();

/** @param {string} text @returns {string} */
function escapeHtmlText(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** @type {import('marked').MarkedExtension} */
const literalTagsExt = {
    renderer: {
        html({ text }) {
            return escapeHtmlText(text);
        },
    },
};

/**
 * @param {string} [escapeStrings] power_user.markdown_escape_strings; pass the real value when calling this from a module that already imports power_user (e.g. on power_user.markdown_escape_strings change), same as the old reloadMarkdownProcessor() was called.
 * @param {(text: string) => string} [substituteParamsFn] The real `substituteParams` from script.js, from a module that already imports it.
 */
export function reloadMarkedProcessor(escapeStrings, substituteParamsFn = identitySubstitute) {
    markedProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedProcessor.use(markdownExclusionExt(escapeStrings, substituteParamsFn));

    markedLiteralTagsProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedLiteralTagsProcessor.use(markdownExclusionExt(escapeStrings, substituteParamsFn));
    markedLiteralTagsProcessor.use(literalTagsExt);
    return markedProcessor;
}

export function renderMarkdown(text) {
    return markedProcessor.parse(text);
}

/**
 * Renders markdown with raw HTML (block and inline tags) shown as literal text; code spans, code blocks
 * and blockquotes render as usual.
 * @param {string} text
 * @returns {string}
 */
export function renderMarkdownLiteralTags(text) {
    return String(markedLiteralTagsProcessor.parse(text));
}

reloadMarkedProcessor();
