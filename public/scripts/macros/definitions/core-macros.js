import { seedrandom, droll } from '../../../lib.js';
import { chat_metadata, main_api, getMaxPromptTokens, getMaxContextTokens, getMaxResponseTokens, extension_prompts, getCurrentChatId } from '../../../script.js';
import { getStringHash, isFalseBoolean } from '../../utils.js';
import { textgenerationwebui_banned_in_macros } from '../../textgen-settings.js';
import { inject_ids } from '../../constants.js';
import { MacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';
import { MACRO_VARIABLE_SHORTHAND_PATTERN } from '../engine/MacroLexer.js';
import { MacroParser } from '../engine/MacroParser.js';
import { MacroCstWalker } from '../engine/MacroCstWalker.js';

// Control characters, unlikely to appear in user-generated content
export const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

export function registerCoreMacros() {
    MacroRegistry.registerMacro('space', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'count',
                optional: true,
                defaultValue: '1',
                type: MacroValueType.INTEGER,
                description: 'Number of spaces to insert.',
            },
        ],
        description: 'Returns one or more spaces. One space by default, more if the count argument is specified.',
        returns: 'One or more spaces.',
        exampleUsage: ['{{space}}', '{{space::4}}'],
        handler: ({ unnamedArgs: [count] }) => ' '.repeat(Number(count ?? 1)),
    });

    MacroRegistry.registerMacro('newline', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'count',
                optional: true,
                defaultValue: '1',
                type: MacroValueType.INTEGER,
                description: 'Number of newlines to insert.',
            },
        ],
        description: 'Inserts one or more newlines. One newline by default, more if the count argument is specified.',
        returns: 'One or more \\n.',
        exampleUsage: ['{{newline}}', '{{newline::2}}'],
        handler: ({ unnamedArgs: [count] }) => '\n'.repeat(Number(count ?? 1)),
    });

    MacroRegistry.registerMacro('noop', {
        category: MacroCategory.UTILITY,
        description: 'Does nothing and produces an empty string.',
        returns: '',
        handler: () => '',
    });

    MacroRegistry.registerMacro('trim', {
        category: MacroCategory.UTILITY,
        description: 'Trims whitespace. Non-scoped: trims newlines around the macro (post-processing). Scoped: returns the content (auto-trimmed by the engine).',
        unnamedArgs: [
            {
                name: 'content',
                description: 'Content to trim (when used as scoped macro)',
                optional: true,
            },
        ],
        returns: '',
        handler: ({ unnamedArgs: [content], isScoped }) => {
            if (isScoped) return content ?? '';
            return '{{trim}}';
        },
    });

    /**
     * Splits raw content on the first {{else}} macro at nesting depth 0.
     * Tracks scoped {{if}}/{{/if}} pairs to find the correct top-level else.
     * Only {{if}} with 1 argument (condition only) are considered scoped blocks.
     *
     * @param {string} content - The raw content to split
     * @returns {{ thenBranch: string, elseBranch: string | undefined }}
     */
    function splitOnTopLevelElse(content) {
        const { cst } = MacroParser.parseDocument(content);
        const macroNodes = /** @type {import('chevrotain').CstNode[]} */ (cst?.children?.macro || []);

        let depth = 0;
        for (const macroNode of macroNodes) {
            const info = MacroCstWalker.extractMacroInfo(macroNode);
            if (!info) continue;

            // Only track scoped {{if}} blocks (1 arg = condition only, expects {{/if}})
            // Inline {{if condition::content}} has 2 args and doesn't affect depth
            if (info.name === 'if' && !info.isClosing && info.argCount === 1) {
                depth++;
            } else if (info.name === 'if' && info.isClosing) {
                depth--;
            } else if (info.name === 'else' && depth === 0) {
                return {
                    thenBranch: content.slice(0, info.startOffset),
                    elseBranch: content.slice(info.endOffset + 1),
                };
            }
        }

        return { thenBranch: content, elseBranch: undefined };
    }

    MacroRegistry.registerMacro('if', {
        category: MacroCategory.UTILITY,
        description: 'Conditional macro. Returns the content if the condition is truthy, otherwise returns nothing (or the else branch if present). Prefix the condition with ! to invert. If the condition is a registered macro name (without braces), it will be resolved first. Variable shorthands (.varname for local, $varname for global) are also supported.',
        unnamedArgs: [
            {
                name: 'condition',
                description: 'The condition to evaluate. Prefix with ! to invert. Can be a macro name (auto-resolved), variable shorthand (.var or $var), or a value. Falsy: empty string, "false", "off", "0".',
            },
            {
                name: 'content',
                description: 'The content to return if condition is truthy (typically provided as scoped content). May contain {{else}} to define an else branch.',
            },
        ],
        displayOverride: '{{if condition}}then{{else}}other{{/if}}',
        exampleUsage: [
            '{{if description}}# Description\n{{description}}{{/if}}',
            '{{if charVersion}}{{charVersion}}{{else}}No version{{/if}}',
            '{{if !personality}}No personality defined{{/if}}',
            '{{if {{getvar::showHeader}}}}# Header{{/if}}',
            '{{if .myvar}}Local var exists{{/if}}',
            '{{if $globalFlag}}Global flag is set{{/if}}',
        ],
        returns: 'The content if condition is truthy, else branch or empty string otherwise.',
        // Delay argument resolution so nested macros are only evaluated in the chosen branch
        delayArgResolution: true,
        handler: ({ unnamedArgs: [rawCondition, rawContent], flags, resolve, trimContent }) => {
            let inverted = false;
            let condition = rawCondition;
            if (/^\s*!/.test(rawCondition)) {
                inverted = true;
                condition = rawCondition.replace(/^\s*!\s*/, '');
            }

            condition = resolve(condition);

            const varShorthandRegex = new RegExp(`^([.$])(${MACRO_VARIABLE_SHORTHAND_PATTERN.source})$`);
            const varShorthandMatch = condition.match(varShorthandRegex);
            if (varShorthandMatch) {
                const [, prefix, varName] = varShorthandMatch;
                const varMacro = prefix === '.' ? 'getvar' : 'getglobalvar';
                condition = resolve(`{{${varMacro}::${varName}}}`);
            } else {
                // Only resolve as a bare macro name if it takes no required args
                const macroDef = MacroRegistry.getPrimaryMacro(condition);
                if (macroDef && macroDef.minArgs === 0) {
                    condition = resolve(`{{${condition}}}`);
                }
            }

            let isFalsy = condition === '' || isFalseBoolean(condition);
            if (inverted) isFalsy = !isFalsy;

            const { thenBranch, elseBranch } = splitOnTopLevelElse(rawContent);

            const chosenBranch = !isFalsy ? thenBranch : elseBranch;
            if (chosenBranch === undefined) {
                return '';
            }

            let result = resolve(chosenBranch);
            if (!flags.preserveWhitespace) {
                result = trimContent(result);
            }
            return result;
        },
    });

    MacroRegistry.registerMacro('else', {
        category: MacroCategory.UTILITY,
        description: 'Marks the else branch inside a scoped {{if}} block. Only works inside {{if}}...{{/if}}. If used outside, returns an invisible marker.',
        exampleUsage: [
            '{{if condition}}true branch{{else}}false branch{{/if}}',
        ],
        returns: 'Invisible marker (consumed by the enclosing {{if}} macro).',
        handler: () => ELSE_MARKER,
    });

    MacroRegistry.registerMacro('input', {
        category: MacroCategory.UTILITY,
        description: 'Current text from the send textarea.',
        returns: 'Current text from the send textarea.',
        handler: () => (/** @type {HTMLTextAreaElement} */(document.querySelector('#send_textarea')))?.value ?? '',
    });

    MacroRegistry.registerMacro('maxPrompt', {
        aliases: [{ alias: 'maxPromptTokens', visible: true }],
        category: MacroCategory.STATE,
        description: 'Maximum prompt context size.',
        returns: 'Maximum prompt context size.',
        returnType: MacroValueType.INTEGER,
        handler: () => String(getMaxPromptTokens()),
    });

    MacroRegistry.registerMacro('maxContext', {
        aliases: [{ alias: 'maxContextTokens', visible: true }],
        category: MacroCategory.STATE,
        description: 'Maximum context token limit.',
        returns: 'Maximum context token limit.',
        returnType: MacroValueType.INTEGER,
        handler: () => String(getMaxContextTokens()),
    });

    MacroRegistry.registerMacro('maxResponse', {
        aliases: [{ alias: 'maxResponseTokens', visible: true }],
        category: MacroCategory.STATE,
        description: 'Maximum response token limit.',
        returns: 'Maximum response token limit.',
        returnType: MacroValueType.INTEGER,
        handler: () => String(getMaxResponseTokens()),
    });

    MacroRegistry.registerMacro('reverse', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'value',
                type: MacroValueType.STRING,
                description: 'The string to reverse.',
            },
        ],
        description: 'Reverses the characters of the argument provided.',
        returns: 'Reversed string.',
        exampleUsage: ['{{reverse::I am Lana}}'],
        handler: ({ unnamedArgs: [value] }) => Array.from(value).reverse().join(''),
    });

    MacroRegistry.registerMacro('//', {
        aliases: [{ alias: 'comment', visible: false }],
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'comment',
                type: MacroValueType.STRING,
                description: 'Any kind of text as comment. If you want multiline comments, consider using a scoped macro like {{//}}First\nSecond{{///}}.',
            },
        ],
        description: 'Comment macro that produces an empty string. Can be used for writing into prompt definitions, without being passed to the context.',
        returns: '',
        displayOverride: '{{// ...}}',
        exampleUsage: ['{{// This is a comment}}'],
        handler: () => '',
    });

    MacroRegistry.registerMacro('roll', {
        category: MacroCategory.RANDOM,
        unnamedArgs: [
            {
                name: 'formula',
                sampleValue: '1d20',
                description: 'Dice roll formula using droll syntax (e.g. 1d20).',
                type: 'string',
            },
        ],
        description: 'Rolls dice using droll syntax (e.g. {{roll 1d20}}).',
        returns: 'Dice roll result.',
        returnType: MacroValueType.INTEGER,
        exampleUsage: [
            '{{roll::1d20}}',
            '{{roll::6}}',
            '{{roll::3d6+4}}',
        ],
        handler: ({ unnamedArgs: [formula], warn }) => {
            // If only digits were provided, treat it as `1dX`.
            if (/^\d+$/.test(formula)) {
                formula = `1d${formula}`;
            }

            const isValid = droll.validate(formula);
            if (!isValid) {
                warn(`Invalid roll formula: ${formula}`);
                return '';
            }

            const result = droll.roll(formula);
            if (result === false) return '';
            return String(result.total);
        },
    });

    MacroRegistry.registerMacro('random', {
        category: MacroCategory.RANDOM,
        list: true,
        description: 'Picks a random item from a list. Will be re-rolled every time macros are resolved.',
        returns: 'Randomly selected item from the list.',
        exampleUsage: ['{{random::blonde::brown::red::black::blue}}'],
        handler: ({ list }) => {
            if (list.length === 1) {
                list = readSingleArgsRandomList(list[0]);
            }

            if (list.length === 0) {
                return '';
            }

            const rng = seedrandom('added entropy.', { entropy: true });
            const randomIndex = Math.floor(rng() * list.length);
            return list[randomIndex];
        },
    });

    MacroRegistry.registerMacro('pick', {
        category: MacroCategory.RANDOM,
        list: true,
        description: 'Picks a random item from a list, but keeps the choice stable for a given chat and macro position. Can be rerolled via /reroll-pick slash command.',
        returns: 'Stable randomly selected item from the list.',
        exampleUsage: ['{{pick::blonde::brown::red::black::blue}}'],
        handler: ({ list, globalOffset, env }) => {
            if (list.length === 1) {
                list = readSingleArgsRandomList(list[0]);
            }

            if (!list.length) {
                return '';
            }

            // Keep in sync with registerTestablePick() if this hashing logic changes
            const chatIdHash = getChatIdHash();
            const rawContentHash = env.contentHash;
            // globalOffset differentiates otherwise-identical macros at different positions in the document
            const offset = globalOffset;
            const rerollSeed = chat_metadata.pick_reroll_seed || null;

            const combinedSeedString = [chatIdHash, rawContentHash, offset, rerollSeed].filter(it => it !== null).join('-');
            const finalSeed = getStringHash(combinedSeedString);
            const rng = seedrandom(String(finalSeed));
            const randomIndex = Math.floor(rng() * list.length);
            return list[randomIndex];
        },
    });

    /** @param {string} listString @return {string[]} */
    function readSingleArgsRandomList(listString) {
        // A single colon introducing the list (e.g. {{random:a::b::c}}) leaves '::' as separator, taking precedence over commas
        if (listString.includes('::')) {
            return listString.split('::').map((/** @type {string} */ item) => item.trim());
        }
        return listString
            .replace(/\\,/g, '##�COMMA�##')
            .split(',')
            .map((/** @type {string} */ item) => item.trim().replace(/##�COMMA�##/g, ','));
    }

    MacroRegistry.registerMacro('banned', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'word',
                sampleValue: 'word',
                description: 'Word to ban for Text Completion backend.',
                type: 'string',
            },
        ],
        description: 'Bans a word for Text Completion backend. (Strips quotes surrounding the banned word, if present)',
        returns: '',
        exampleUsage: ['{{banned::delve}}'],
        handler: ({ unnamedArgs: [bannedWord] }) => {
            bannedWord = bannedWord.replace(/^"|"$/g, '');
            if (main_api === 'textgenerationwebui') {
                console.log('Found banned word in macros: ' + bannedWord);
                textgenerationwebui_banned_in_macros.push(bannedWord);
            }
            return '';
        },
    });

    MacroRegistry.registerMacro('outlet', {
        category: MacroCategory.UTILITY,
        unnamedArgs: [
            {
                name: 'key',
                sampleValue: 'my-outlet-key',
                description: 'Outlet key.',
                type: 'string',
            },
        ],
        description: 'Returns the world info outlet prompt for a given outlet key.',
        returns: 'World info outlet prompt.',
        exampleUsage: ['{{outlet::character-achievements}}'],
        handler: ({ unnamedArgs: [outlet] }) => {
            if (!outlet) return '';
            const value = extension_prompts[inject_ids.CUSTOM_WI_OUTLET(outlet)]?.value;
            return value || '';
        },
    });
}

function getChatIdHash() {
    const cachedIdHash = chat_metadata.chat_id_hash;
    if (typeof cachedIdHash === 'number') {
        return cachedIdHash;
    }

    const chatId = chat_metadata.main_chat ?? getCurrentChatId();
    const chatIdHash = getStringHash(chatId);
    chat_metadata.chat_id_hash = chatIdHash;
    return chatIdHash;
}
