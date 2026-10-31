/**
 * @param {{ story_string?: string, story_string_position?: number } | null | undefined} contextSettings
 * @returns {string}
 */
export function storyStringWithAnchors(contextSettings) {
    let storyString = contextSettings?.story_string || '';
    if (!contextSettings || Object.hasOwn(contextSettings, 'story_string_position')) {
        return storyString;
    }

    /**
     * @param {string} field
     * @param {'start'|'end'} position
     */
    function autoFixMissingField(field, position) {
        if (storyString.includes(`{{${field}}}`)) {
            return;
        }

        console.warn(`[Story String Validation] Story String is missing a field: ${field}. Adding it at the ${position}.`);
        const fieldTemplate = `{{#if ${field}}}{{${field}}}\n{{/if}}`;
        const firstCurlyPosition = storyString.includes('{{') ? storyString.indexOf('{{') : 0;
        const lastCurlyPosition = storyString.includes('}}') ? storyString.lastIndexOf('}}') + '}}'.length : storyString.length;
        const lastTrimPosition = storyString.includes('{{trim}}') ? storyString.lastIndexOf('{{trim}}') : storyString.length;
        const endPosition = Math.min(lastTrimPosition, lastCurlyPosition);
        storyString = position === 'start'
            ? storyString.substring(0, firstCurlyPosition) + fieldTemplate + storyString.substring(firstCurlyPosition)
            : storyString.substring(0, endPosition) + fieldTemplate + storyString.substring(endPosition);
    }

    autoFixMissingField('anchorBefore', 'start');
    autoFixMissingField('anchorAfter', 'end');
    return storyString;
}
