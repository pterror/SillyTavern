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
 * @property {{ name: string, entries: Record<string, unknown>[] }} [lorebook] A lorebook made before the chat opens, the
 *   chat's own (`chatMetadata.world_info` names it).
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
        name: 'tc-authors-note',
        card: { ch_name: 'Parity Sailor', first_mes: 'The sea is calm.', description: 'An old sailor.' },
        steps: ['/send What do you see?', '/sendas name="Parity Sailor" Clouds, far off.', '/send Should we turn back?'],
        // In the chat, one message deep, after every message.
        chatMetadata: { note_prompt: '{{char}} senses a storm coming.', note_interval: 1, note_position: 1, note_depth: 1, note_role: 0 },
    },
    {
        name: 'tc-injections',
        card: { ch_name: 'Parity Hermit', first_mes: 'Who goes there?', description: 'A hermit in a cave.' },
        steps: [
            '/send Only a traveller.',
            '/sendas name="Parity Hermit" Come in, then.',
            '/send Thank you.',
            '/inject id=parity-chat position=chat depth=1 The fire crackles.',
            '/inject id=parity-before position=before {{char}} lives alone.',
            '/inject id=parity-after position=after It is winter.',
        ],
    },
    {
        name: 'tc-lorebook-positions',
        card: { ch_name: 'Parity Ranger', first_mes: 'The forest is quiet.', description: 'A forest ranger. Outlet: {{outlet::parity-outlet}}', scenario: 'A patrol at dusk.' },
        lorebook: {
            name: 'Parity Forest Lore',
            entries: [
                { content: 'Before the character: the forest is old.', position: 0 },
                { content: 'After the character: wolves roam here.', position: 1 },
                { content: 'Top of the note: the moon is full.', position: 2 },
                { content: 'Bottom of the note: owls call.', position: 3 },
                { content: 'At depth two: a branch snaps.', position: 4, depth: 2, role: 0 },
                { content: 'Before the examples: rangers whistle.', position: 5 },
                { content: 'After the examples: rangers nod.', position: 6 },
                { content: 'In the outlet: the river is cold.', position: 7, outletName: 'parity-outlet' },
            ],
        },
        steps: ['/send Any tracks?', '/sendas name="Parity Ranger" Fresh ones.', '/send Whose?'],
        chatMetadata: { world_info: 'Parity Forest Lore', note_prompt: 'Stay alert.', note_interval: 1, note_position: 1, note_depth: 1, note_role: 0 },
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
 * @returns {Promise<Record<string, unknown>>} The values they replaced, to put back.
 */
export async function applyPowerUser(values) {
    // @ts-ignore - the page's own module
    const { power_user } = await import('/scripts/power-user.js');
    /** @type {Record<string, unknown>} */
    const replaced = {};
    for (const [path, value] of Object.entries(values)) {
        const keys = path.split('.');
        let target = power_user;
        for (const key of keys.slice(0, -1)) target = target[key];
        replaced[path] = structuredClone(target[keys[keys.length - 1]]);
        target[keys[keys.length - 1]] = value;
    }
    return replaced;
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
    // The page's Author's Note reads its text from its panel's field, filled from the metadata when a chat opens.
    if (typeof values.note_prompt === 'string') $('#extension_floating_prompt').val(values.note_prompt);
}

/**
 * Makes a lorebook of constant entries (each always on), in the page. Run with page.evaluate().
 * @param {{ name: string, entries: Record<string, unknown>[] }} book
 */
export async function createLorebook(book) {
    // @ts-ignore
    const context = SillyTavern.getContext();
    /** @type {Record<string, unknown>} */
    const entries = {};
    book.entries.forEach((entry, uid) => {
        entries[uid] = {
            uid, key: [], keysecondary: [], comment: `Entry ${uid}`, constant: true, selective: false, disable: false,
            order: 100, depth: 4, role: 0, probability: 100, useProbability: false, excludeRecursion: false,
            preventRecursion: false, addMemo: true, displayIndex: uid, ...entry,
        };
    });
    const response = await fetch('/api/worldinfo/edit', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name: book.name, data: { entries } }) });
    if (!response.ok) throw new Error(`lorebook not saved: ${response.status}`);
}
