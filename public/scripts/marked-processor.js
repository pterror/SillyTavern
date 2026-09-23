import { Marked } from '../lib.js';
import { power_user } from './power-user.js';
import { substituteParams } from '../script.js';

const EXCLUSION_MARKER = '​';

/**
 * @returns {import('marked').MarkedExtension}
 */
export function markdownExclusionExt() {
    if (!power_user || !power_user.markdown_escape_strings) {
        return {};
    }

    return {
        hooks: {
            preprocess(markdown) {
                const escapedExclusions = substituteParams(power_user.markdown_escape_strings)
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

export function reloadMarkedProcessor() {
    markedProcessor = new Marked({
        gfm: true,
        breaks: true,
    });
    markedProcessor.use(markdownExclusionExt());
    return markedProcessor;
}

export function renderMarkdown(text) {
    return markedProcessor.parse(text);
}

reloadMarkedProcessor();
