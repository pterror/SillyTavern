/**
 * The codes the library's records name entities and values by, shared by the library's modules.
 */

export const TYPE = Object.freeze({ character: 0, group: 1, tag: 2 });

/** Field codes; the engine reads NAME, WORLD, FOLDER_TYPE and DEFINED itself. */
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
    allow_global_styles: 30,
    folder_type: 40,
    /** A tag's definition marker (empty JSON): without it, the tag is a key only assignments name. */
    defined: 41,
});

/** A tag's keys other than its name and folder type are stored by key. */
export const TAG_KEY_PREFIX = 'tag:';
