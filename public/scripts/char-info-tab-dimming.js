/**
 * Dims a character info tab's heading when the tab holds nothing: there is no point opening it.
 * Any text counts as something, whitespace included.
 */

/** The field each tab shows, by the tab's `charInfoTabs_tab` radio value. */
const TAB_FIELDS = {
    creatorNotes: 'creator_notes_textarea',
    description: 'description_textarea',
    greeting: 'greeting_field',
    mainPrompt: 'system_prompt_textarea',
    postHistoryInstructions: 'post_history_instructions_textarea',
    personality: 'personality_textarea',
    scenario: 'scenario_pole',
    characterNote: 'depth_prompt_prompt',
    exampleMessages: 'mes_example_textarea',
};

/** @type {() => boolean} Whether a greeting other than the one in `greeting_field` has text. */
let anotherGreetingHasText = () => false;

export function refreshCharInfoTabDimming() {
    for (const radio of document.querySelectorAll('#charInfoTabs > .tab-title > input[name="charInfoTabs_tab"]')) {
        if (!(radio instanceof HTMLInputElement)) continue;
        const field = document.getElementById(TAB_FIELDS[radio.value]);
        if (!(field instanceof HTMLTextAreaElement)) continue;
        const isEmpty = field.value === '' && !(radio.value === 'greeting' && anotherGreetingHasText());
        radio.parentElement.classList.toggle('tab-empty', isEmpty);
    }
}

/**
 * @param {() => boolean} anotherGreetingHasTextCheck Whether a greeting other than the one in `greeting_field` has text.
 */
export function initCharInfoTabDimming(anotherGreetingHasTextCheck) {
    anotherGreetingHasText = anotherGreetingHasTextCheck;
    // jQuery, so that `.trigger('input')` after a programmatic write is heard too.
    $('#charInfoTabs').on('input', refreshCharInfoTabDimming);
    refreshCharInfoTabDimming();
}
