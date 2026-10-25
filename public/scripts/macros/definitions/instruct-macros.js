import { MacroRegistry, MacroCategory } from '../engine/MacroRegistry.js';

/**
 * Registers instruct-mode related {{...}} macros (instruct* and system
 * prompt/context macros) in the MacroRegistry.
 */
export function registerInstructMacros() {
    /**
     * Helper to register macros that just expose a value of the instruct template.
     * The first name is the primary, subsequent names become visible aliases.
     * @param {string[]} names - First is primary, rest are aliases.
     * @param {(state: import('../engine/MacroEnv.types.js').MacroEnvState) => string} getValue
     * @param {(state: import('../engine/MacroEnv.types.js').MacroEnvState) => boolean} isEnabled
     * @param {string} description
     * @param {string} [category=MacroCategory.PROMPTS]
     */
    function registerSimple(names, getValue, isEnabled, description, category = MacroCategory.PROMPTS) {
        const [primary, ...aliasNames] = names;
        const aliases = aliasNames.map(alias => ({ alias }));

        MacroRegistry.registerMacro(primary, {
            category,
            description,
            aliases: aliases.length > 0 ? aliases : undefined,
            handler: ({ env }) => (isEnabled(env.state) ? (getValue(env.state) ?? '') : ''),
        });
    }

    const instEnabled = (/** @type {any} */ state) => !!state.instruct?.enabled;
    const sysEnabled = (/** @type {any} */ state) => !!state.sysprompt?.enabled;

    // Instruct template macros
    registerSimple(['instructStoryStringPrefix'], state => state.instruct?.story_string_prefix, instEnabled, 'Instruct story string prefix.');
    registerSimple(['instructStoryStringSuffix'], state => state.instruct?.story_string_suffix, instEnabled, 'Instruct story string suffix.');

    registerSimple(['instructUserPrefix', 'instructInput'], state => state.instruct?.input_sequence, instEnabled, 'Instruct input / user prefix sequence.');
    registerSimple(['instructUserSuffix'], state => state.instruct?.input_suffix, instEnabled, 'Instruct input / user suffix sequence.');

    registerSimple(['instructAssistantPrefix', 'instructOutput'], state => state.instruct?.output_sequence, instEnabled, 'Instruct output / assistant prefix sequence.');
    registerSimple(['instructAssistantSuffix', 'instructSeparator'], state => state.instruct?.output_suffix, instEnabled, 'Instruct output / assistant suffix sequence.');

    registerSimple(['instructSystemPrefix'], state => state.instruct?.system_sequence, instEnabled, 'Instruct system prefix sequence.');
    registerSimple(['instructSystemSuffix'], state => state.instruct?.system_suffix, instEnabled, 'Instruct system suffix sequence.');

    registerSimple(['instructFirstAssistantPrefix', 'instructFirstOutputPrefix'], state => state.instruct?.first_output_sequence || state.instruct?.output_sequence, instEnabled, 'Instruct first assistant / output prefix sequence');
    registerSimple(['instructLastAssistantPrefix', 'instructLastOutputPrefix'], state => state.instruct?.last_output_sequence || state.instruct?.output_sequence, instEnabled, 'Instruct last assistant / output prefix sequence.');

    registerSimple(['instructStop'], state => state.instruct?.stop_sequence, instEnabled, 'Instruct stop sequence.');
    registerSimple(['instructUserFiller'], state => state.instruct?.user_alignment_message, instEnabled, 'Instruct user alignment filler.');
    registerSimple(['instructSystemInstructionPrefix'], state => state.instruct?.last_system_sequence, instEnabled, 'Instruct system instruction prefix sequence.');

    registerSimple(['instructFirstUserPrefix', 'instructFirstInput'], state => state.instruct?.first_input_sequence || state.instruct?.input_sequence, instEnabled, 'Instruct first user / input prefix sequence.');
    registerSimple(['instructLastUserPrefix', 'instructLastInput'], state => state.instruct?.last_input_sequence || state.instruct?.input_sequence, instEnabled, 'Instruct last user / input prefix sequence.');

    // System prompt macros
    registerSimple(['defaultSystemPrompt', 'instructSystem', 'instructSystemPrompt'], state => state.sysprompt?.content, sysEnabled, 'Default system prompt.');

    MacroRegistry.registerMacro('systemPrompt', {
        category: MacroCategory.PROMPTS,
        description: 'Active system prompt text (optionally overridden by character prompt)',
        handler: ({ env }) => {
            if (!env.state.sysprompt?.enabled) return '';

            if (env.state.preferCharacterPrompt && env.character.charPrompt) {
                return env.character.charPrompt;
            }
            return env.state.sysprompt.content ?? '';
        },
    });

    // Context template macros
    registerSimple(['exampleSeparator', 'chatSeparator'], state => state.context?.example_separator, () => true, 'Separator used between example chat blocks in text completion prompts.');
    registerSimple(['chatStart'], state => state.context?.chat_start, () => true, 'Chat start marker used in text completion prompts.');
}
