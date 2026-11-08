export const TYPE = Object.freeze({
    character: 0, group: 1, tag: 2, book: 3, ownedBook: 4, entry: 5, tree: 6, viewList: 7, view: 8, condition: 9, range: 10,
    user: 11, samplerPreset: 12, template: 13, chatPrompt: 14, chatPromptOrder: 15, biasList: 16, biasEntry: 17,
    connection: 18, connectionProfile: 19, proxy: 20, persona: 21, theme: 22, quickReplySet: 23, quickReply: 24,
    regexScript: 25, regexPreset: 26, globalVariable: 27, dataBankFile: 28, modelTemplateBinding: 29,
    movingUiPreset: 31, serverHistory: 32, movingUiLayout: 33, device: 34, background: 35, personaImage: 36,
    userImage: 37,
});

export const HASH = Object.freeze({ identity: 0, content: 1, avatarIdentity: 3, animated: 4 });

export const FIELD = Object.freeze({
    name: 1,
    creator: 2,
    character_version: 3,
    world: 4,
    create_date: 5,
    description: 10,
    personality: 11,
    scenario: 12,
    first_mes: 13,
    mes_example: 14,
    creator_notes: 15,
    system_prompt: 16,
    post_history_instructions: 17,
    nickname: 18,
    creation_date: 19,
    modification_date: 20,
    first_mes_item: 21,
    greeting_next_item: 22,
    allow_global_styles: 30,
    folder_type: 40,
    defined: 41,
});

export const TAG_KEY_PREFIX = 'tag:';

export const STATEMENT_PREFIX = 'stmt:';

/**
 * @param {string} name
 */
export const convertedFileKey = name => `converted.characters.${name}`;

export const KEPT_ITEMIZATION_FILES = 'itemized prompts.kept';

export const NAME_HISTORY = 3;

/**
 * @param {{ until: number, name: string }} entry
 */
export const renameItem = entry => `${entry.until} ${entry.name}`;

/**
 * @param {string[] | undefined} items
 * @returns {{ until: number, name: string }[]}
 */
export const renamesOf = items => (items ?? []).map(text => {
    const space = text.indexOf(' ');
    return { until: Number(text.slice(0, space)), name: text.slice(space + 1) };
});
