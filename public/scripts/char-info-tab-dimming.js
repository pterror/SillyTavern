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

/** @type {() => boolean} */
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
 * @param {() => boolean} anotherGreetingHasTextCheck
 */
export function initCharInfoTabDimming(anotherGreetingHasTextCheck) {
    anotherGreetingHasText = anotherGreetingHasTextCheck;
    $('#charInfoTabs').on('input', refreshCharInfoTabDimming);
    refreshCharInfoTabDimming();
}
