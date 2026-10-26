// The chats the prompt parity test builds a prompt for (PromptParity.e2e.js), and that upstream's page built its
// prompt for (prompt-goldens.mjs, kept in prompt-goldens/): upstream's prompt is the reference for every one.

/**
 * @typedef {object} ParityCase
 * @property {string} name The case's file name in prompt-goldens/.
 * @property {Record<string, string>} card Create form fields; `ch_name` is the character's name as is.
 * @property {Record<string, unknown>} [powerUser] power_user values set over the defaults, by dotted path
 *   (`context.chat_start`).
 * @property {string[]} steps Slash commands run in the chat before the prompt is built.
 * @property {Record<string, unknown>} [chatMetadata] Chat metadata set after the steps (an author's note: `note_prompt`, …).
 * @property {string} [type] The generation's type.
 */

/** @type {ParityCase[]} */
export const PARITY_CASES = [
    {
        name: 'tc-plain',
        card: {
            ch_name: 'Parity Innkeeper',
            first_mes: 'Hello, traveller.',
            description: 'A quiet innkeeper.',
            personality: 'Patient.',
            scenario: 'A rainy evening at the inn.',
            mes_example: '<START>\n{{user}}: Hi.\n{{char}}: Welcome.',
        },
        steps: ['/send I would like a room.'],
    },
    {
        name: 'tc-instruct-chatml',
        card: { ch_name: 'Parity Scribe', first_mes: 'Ink is ready.', description: 'A scribe who copies books.', mes_example: '<START>\n{{user}}: Copy this.\n{{char}}: At once.' },
        powerUser: {
            'instruct.enabled': true,
            'instruct.input_sequence': '<|im_start|>user',
            'instruct.output_sequence': '<|im_start|>assistant',
            'instruct.last_output_sequence': '',
            'instruct.system_sequence': '<|im_start|>system',
            'instruct.stop_sequence': '<|im_end|>',
            'instruct.wrap': true,
            'instruct.macro': true,
            'instruct.names_behavior': 'force',
            'instruct.first_output_sequence': '',
            'instruct.skip_examples': false,
            'instruct.output_suffix': '<|im_end|>\n',
            'instruct.input_suffix': '<|im_end|>\n',
            'instruct.system_suffix': '<|im_end|>\n',
            'instruct.user_alignment_message': '',
            'instruct.system_same_as_user': false,
            'instruct.last_system_sequence': '',
            'instruct.first_input_sequence': '',
            'instruct.last_input_sequence': '',
            'instruct.story_string_prefix': '<|im_start|>system',
            'instruct.story_string_suffix': '<|im_end|>\n',
        },
        steps: ['/send Please copy the first chapter.'],
    },
    {
        name: 'tc-system-prompt',
        card: { ch_name: 'Parity Guard', first_mes: 'Halt.', description: 'A gate guard.' },
        powerUser: { 'sysprompt.enabled': true, 'sysprompt.content': 'You are {{char}}. Stay in character and answer {{user}} briefly.' },
        steps: ['/send May I pass?'],
    },
    {
        name: 'tc-macros',
        card: {
            ch_name: 'Parity Herald',
            first_mes: 'Greetings, {{user}}! I am {{char}}.',
            description: '{{char}} announces visitors to the court. {{char}} calls {{user}} by name.',
            personality: '{{char}} is loud.',
            mes_example: '<START>\n{{user}}: Who is here?\n{{char}}: {{user}}, the court awaits.',
        },
        steps: ['/send Announce me.'],
    },
    {
        name: 'tc-depth-prompt',
        card: { ch_name: 'Parity Miner', first_mes: 'Dig, dig.', description: 'A miner deep underground.', depth_prompt_prompt: 'Remember: {{char}} is tired.', depth_prompt_depth: '2', depth_prompt_role: 'system' },
        steps: ['/send Found anything?', '/sendas name="Parity Miner" Just rocks.', '/send Keep going.'],
    },
    {
        name: 'tc-continue',
        card: { ch_name: 'Parity Bard', first_mes: 'A song for you.', description: 'A travelling bard.' },
        steps: ['/send Sing about the sea.', '/sendas name="Parity Bard" Oh, the waves they roll and'],
        type: 'continue',
    },
    {
        name: 'tc-impersonate',
        card: { ch_name: 'Parity Merchant', first_mes: 'Fine wares!', description: 'A merchant at a stall.' },
        steps: ['/send How much for the lamp?', '/sendas name="Parity Merchant" Ten silver.'],
        type: 'impersonate',
    },
];

/**
 * Sets power_user values by dotted path, in the page. Run with page.evaluate().
 * @param {Record<string, unknown>} values
 */
export async function applyPowerUser(values) {
    // @ts-ignore - the page's own module
    const { power_user } = await import('/scripts/power-user.js');
    for (const [path, value] of Object.entries(values)) {
        const keys = path.split('.');
        let target = power_user;
        for (const key of keys.slice(0, -1)) target = target[key];
        target[keys[keys.length - 1]] = value;
    }
}

/**
 * Sets the open chat's metadata and saves it, in the page. Run with page.evaluate().
 * @param {Record<string, unknown>} values
 */
export async function applyChatMetadata(values) {
    // @ts-ignore
    const context = SillyTavern.getContext();
    Object.assign(context.chatMetadata, values);
    await context.saveMetadata();
    // Upstream's Author's Note reads its panel, which takes the chat's metadata when the chat changes.
    await context.eventSource.emit(context.eventTypes.CHAT_CHANGED, context.getCurrentChatId());
}
