// The story string as an older context template is used: it gets the before and after anchors (where injections at
// those places go) when it has neither place for them. A leaf module: the server uses it too.

/**
 * The story string of a context template, the anchors added where a template from before they existed lacks them:
 * `{{anchorBefore}}` before its first field, `{{anchorAfter}}` after its last. A template that has the story string's
 * position setting is already of the anchors' time, and is used as it is.
 * @param {{ story_string?: string, story_string_position?: number } | null | undefined} contextSettings
 * @returns {string}
 */
export function storyStringWithAnchors(contextSettings) {
    let storyString = contextSettings?.story_string || '';
    if (!contextSettings || Object.hasOwn(contextSettings, 'story_string_position')) {
        return storyString;
    }

    /**
     * @param {string} field Missing field name
     * @param {'start'|'end'} position Position of auto-fix
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
