/**
 * @param {string} text
 * @returns {string}
 */
export function editorText(text) {
    return text.replace(/\r\n?/g, '\n');
}

/** @type {Record<string, (character: Record<string, any>) => string>} */
const COUNTED_FIELDS = {
    '#character_name_pole': character => String(character.name ?? ''),
    '#description_textarea': character => String(character.description ?? ''),
    '#personality_textarea': character => String(character.personality ?? ''),
    '#scenario_pole': character => String(character.scenario ?? ''),
    '#mes_example_textarea': character => String(character.mes_example ?? ''),
    '#system_prompt_textarea': character => String(character.data?.system_prompt || ''),
    '#post_history_instructions_textarea': character => String(character.data?.post_history_instructions || ''),
    '#depth_prompt_prompt': character => String(character.data?.extensions?.depth_prompt?.prompt ?? ''),
};

/**
 * @param {string} formId
 * @returns {boolean}
 */
export function isCountedCardField(formId) {
    return Object.hasOwn(COUNTED_FIELDS, formId);
}

/**
 * @param {Record<string, any>} character
 * @param {string} formId One for which isCountedCardField() is true
 * @returns {string}
 */
export function countedCardFieldValue(character, formId) {
    return COUNTED_FIELDS[formId](character);
}

/**
 * The editor counts tokens of each counted field and of the greeting it shows, which can be any of the card's.
 * @param {Record<string, any>} character A whole card
 * @param {string[]} greetings The card's greetings, in the greetings model's order
 * @returns {string[]}
 */
export function cardTokenTexts(character, greetings) {
    return [
        ...Object.values(COUNTED_FIELDS).map(read => read(character)),
        ...greetings.map(text => String(text ?? '')),
    ].map(editorText);
}
