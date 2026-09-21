import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { activateSendButtons, deactivateSendButtons, generateQuietPrompt, generateRaw, main_api, stopGeneration } from '../../../script.js';
import { chat_metadata } from '../../chat-state.js';
import { characters } from '../../character-store.js';
import { saveMetadataDebounced } from '../../extensions.js';
import { t } from '../../i18n.js';
import { addEphemeralStoppingString, flushEphemeralStoppingStrings } from '../../power-user.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { SlashCommandClosure } from '../SlashCommandClosure.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { decodeTextTokens, getFriendlyTokenizerName, getTextTokens, getTokenCountAsync } from '../../tokenizers.js';
import { findChar, isFalseBoolean, isTrueBoolean } from '../../utils.js';
import { resolveVariable } from '../../variables.js';

async function trimTokensCallback(arg, value) {
    if (!value) {
        console.warn('WARN: No argument provided for /trimtokens command');
        return '';
    }

    const limit = Number(resolveVariable(arg.limit));

    if (isNaN(limit)) {
        console.warn(`WARN: Invalid limit provided for /trimtokens command: ${limit}`);
        return value;
    }

    if (limit <= 0) {
        return '';
    }

    const direction = arg.direction || 'end';
    const tokenCount = await getTokenCountAsync(value);

    if (tokenCount <= limit) {
        return value;
    }

    const { tokenizerName, tokenizerId } = getFriendlyTokenizerName(main_api);
    console.debug('Requesting tokenization for /trimtokens command', tokenizerName);

    try {
        const textTokens = getTextTokens(tokenizerId, value);

        if (!Array.isArray(textTokens) || !textTokens.length) {
            console.warn('WARN: No tokens returned for /trimtokens command, falling back to estimation');
            const percentage = limit / tokenCount;
            const trimIndex = Math.floor(value.length * percentage);
            const trimmedText = direction === 'start' ? value.substring(trimIndex) : value.substring(0, value.length - trimIndex);
            return trimmedText;
        }

        const sliceTokens = direction === 'start' ? textTokens.slice(0, limit) : textTokens.slice(-limit);
        const { text } = decodeTextTokens(tokenizerId, sliceTokens);
        return text;
    } catch (error) {
        console.warn('WARN: Tokenization failed for /trimtokens command, returning original', error);
        return value;
    }
}

/**
 *
 * @param {import('../SlashCommand.js').NamedArguments} param0
 * @param {string} [reason]
 */
function abortCallback({ _abortController, quiet }, reason) {
    if (quiet instanceof SlashCommandClosure) throw new Error(t`argument 'quiet' cannot be a closure for command /abort`);
    _abortController.abort((reason ?? '').toString().length == 0 ? t`/abort command executed` : reason, !isFalseBoolean(quiet?.toString() ?? 'true'));
    return '';
}

async function generateRawCallback(args, value) {
    if (!value) {
        console.warn('WARN: No argument provided for /genraw command');
        return '';
    }

    // Prevent generate recursion
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    const lock = isTrueBoolean(args?.lock);
    const as = args?.as || 'system';
    const quietToLoud = as === 'char';
    const systemPrompt = resolveVariable(args?.system) || '';
    const prefillPrompt = resolveVariable(args?.prefill) || '';
    const length = Number(resolveVariable(args?.length) ?? 0) || 0;
    const trimNames = !isFalseBoolean(args?.trim);

    try {
        if (lock) {
            deactivateSendButtons();
        }

        setEphemeralStopStrings(resolveVariable(args?.stop));
        /** @type {import('../../../script.js').GenerateRawParams} */
        const params = {
            prompt: value,
            instructOverride: isFalseBoolean(args?.instruct),
            quietToLoud: quietToLoud,
            systemPrompt: systemPrompt,
            responseLength: length,
            trimNames: trimNames,
            prefill: prefillPrompt,
        };
        const result = await generateRaw(params);
        return result;
    } catch (err) {
        console.error('Error on /genraw generation', err);
        toastr.error(err.message, t`API Error`, { preventDuplicates: true });
    } finally {
        if (lock) {
            activateSendButtons();
        }
        flushEphemeralStoppingStrings();
    }
    return '';
}

/**
 * @returns {Promise<string>} The generated text
 */
async function generateCallback(args, value) {
    // Prevent generate recursion
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    const lock = isTrueBoolean(args?.lock);
    const trim = isTrueBoolean(args?.trim?.toString());
    const as = args?.as || 'system';
    const quietToLoud = as === 'char';
    const length = Number(resolveVariable(args?.length) ?? 0) || 0;

    try {
        if (lock) {
            deactivateSendButtons();
        }

        setEphemeralStopStrings(resolveVariable(args?.stop));
        const name = args?.name;
        const char = name ? findChar({ name: name }) : null;
        /** @type {import('../../../script.js').GenerateQuietPromptParams} */
        const params = {
            quietPrompt: value,
            quietToLoud: quietToLoud,
            quietName: char?.name ?? name,
            responseLength: length,
            trimToSentence: trim,
            forceChId: char ? characters.indexOf(char) : null,
        };
        const result = await generateQuietPrompt(params);
        return result;
    } catch (err) {
        console.error('Error on /gen generation', err);
        toastr.error(err.message, t`API Error`, { preventDuplicates: true });
    } finally {
        if (lock) {
            activateSendButtons();
        }
        flushEphemeralStoppingStrings();
    }
    return '';
}

function setEphemeralStopStrings(value) {
    if (typeof value === 'string' && value.length) {
        try {
            const stopStrings = JSON.parse(value);
            if (Array.isArray(stopStrings)) {
                stopStrings.forEach(stopString => addEphemeralStoppingString(stopString));
            }
        } catch {
        }
    }
}

export function registerGenerationCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'gen',
        callback: generateCallback,
        returns: t`generated text`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'trim',
                description: t`Trim the output by the last sentence boundary`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                isRequired: false,
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            new SlashCommandNamedArgument(
                'lock', t`lock user input during generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, null, commonEnumProviders.boolean('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`in-prompt character name for instruct mode (or unique character identifier (avatar key), which will be used as name)`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'System',
                enumProvider: () => [...commonEnumProviders.characters('character')(), new SlashCommandEnumValue('System', null, enumTypes.enum, enumIcons.assistant)],
            }),
            new SlashCommandNamedArgument(
                'length', t`API response length in tokens`, [ARGUMENT_TYPE.NUMBER], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: t`role of the output prompt`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('char', null, enumTypes.enum, enumIcons.character),
                ],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Generates text using the provided prompt and passes it to the next command through the pipe, optionally locking user input while generating and allowing to configure the in-prompt name for instruct mode (default = "System").`}
        </div>
        <div>
            ${t`"as" argument controls the role of the output prompt: system (default) or char. If "length" argument is provided as a number in tokens, allows to temporarily override an API response length.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'genraw',
        callback: generateRawCallback,
        returns: t`generated text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'lock', t`lock user input during generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', commonEnumProviders.boolean('onOff')(),
            ),
            new SlashCommandNamedArgument(
                'instruct', t`use instruct mode`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'on', commonEnumProviders.boolean('onOff')(),
            ),
            new SlashCommandNamedArgument(
                'stop', t`one-time custom stop strings`, [ARGUMENT_TYPE.LIST], false, false, '[]',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'as',
                description: t`role of the output prompt`,
                defaultValue: 'system',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('char', null, enumTypes.enum, enumIcons.character),
                ],
            }),
            new SlashCommandNamedArgument(
                'system', t`system prompt at the start`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.VARIABLE_NAME], false,
            ),
            new SlashCommandNamedArgument(
                'prefill', t`prefill prompt at the end`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.VARIABLE_NAME], false,
            ),
            new SlashCommandNamedArgument(
                'length', t`API response length in tokens`, [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.VARIABLE_NAME], false,
            ),
            new SlashCommandNamedArgument(
                'trim', t`trim {{user}} and {{char}} prefixes from the output`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'on', commonEnumProviders.boolean('onOff')(),
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Generates text using the provided prompt and passes it to the next command through the pipe, optionally locking user input while generating. Does not include chat history or character card.`}
        </div>
        <div>
            ${t`Use instruct=off to skip instruct formatting, e.g. <pre><code>/genraw instruct=off Why is the sky blue?</code></pre>`}
        </div>
        <div>
            ${t`Use stop=... with a JSON-serialized array to add one-time custom stop strings, e.g. <pre><code>/genraw stop=["\\n"] Say hi</code></pre>`}
        </div>
        <div>
            ${t`"as" argument controls the role of the output prompt: system (default) or char. "system" argument adds an (optional) system prompt at the start.`}
        </div>
        <div>
            ${t`If "length" argument is provided as a number in tokens, allows to temporarily override an API response length.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'stop',
        callback: () => {
            const stopped = stopGeneration();
            return String(stopped);
        },
        returns: t`true/false, whether the generation was running and got stopped`,
        helpString: `
            <div>
                ${t`Stops the generation and any streaming if it is currently running.`}
            </div>
            <div>
                ${t`Note: This command cannot be executed from the chat input, as sending any message or script from there is blocked during generation. But it can be executed via automations or QR scripts/buttons.`}
            </div>
        `,
        aliases: ['generate-stop'],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'abort',
        callback: abortCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Whether to suppress the toast message notifying about the /abort call.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`The reason for aborting command execution. Shown when quiet=false`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: t`Aborts the slash command batch execution.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trimtokens',
        callback: trimTokensCallback,
        returns: t`trimmed text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'limit', t`number of tokens to keep`, [ARGUMENT_TYPE.NUMBER], true,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'direction',
                description: t`trim direction`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumList: [
                    new SlashCommandEnumValue('start', null, enumTypes.enum, '⏪'),
                    new SlashCommandEnumValue('end', null, enumTypes.enum, '⏩'),
                ],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
        <div>
            ${t`Trims the start or end of text to the specified number of tokens.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/trimtokens limit=5 direction=start This is a long sentence with many words</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokens',
        callback: async (_, text) => {
            if (text instanceof SlashCommandClosure || Array.isArray(text)) throw new Error(t`Unnamed argument cannot be a closure for command /tokens`);
            return String(await getTokenCountAsync(text));
        },
        returns: t`number of tokens`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Counts the number of tokens in the provided text.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'reroll-pick',
        callback: (_, value) => {
            const currentSeed = chat_metadata.pick_reroll_seed ?? 0;
            const parsedValue = value ? parseInt(String(value), 10) : NaN;

            if (!isNaN(parsedValue)) {
                chat_metadata.pick_reroll_seed = parsedValue;
            } else {
                chat_metadata.pick_reroll_seed = currentSeed + 1;
            }

            saveMetadataDebounced();
            return String(chat_metadata.pick_reroll_seed);
        },
        returns: t`The new reroll seed value.`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Optional seed value to set. If not provided, increments current seed by 1.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
        ],
        helpString: `
            <div>
                ${t`Rerolls all <code>{{pick}}</code> macro choices in the current chat.`}
            </div>
            <div>
                ${t`The <code>{{pick}}</code> macro normally keeps stable choices per chat. This command changes the seed used for all picks, causing them to resolve to (possibly) different values.`}
            </div>
            <div>
                ${t`If a number is provided, sets the seed to that value. Otherwise, increments the current seed by 1.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <ul>
                    <li><pre><code>/reroll-pick</code></pre> ${t`Increments the seed by 1.`}</li>
                    <li><pre><code>/reroll-pick 5</code></pre> ${t`Sets the seed to 5.`}</li>
                </ul>
            </div>
        `,
    }));
}
