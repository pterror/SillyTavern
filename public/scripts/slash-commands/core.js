import { SlashCommandParser } from './SlashCommandParser.js';
import { addOneMessage, chat, chatOpAppend, chatOpGraft, chat_metadata, default_avatar, eventSource, event_types, extractMessageBias, generateQuietPrompt, getCurrentCharacter, getThumbnailUrl, name1, name2, neutralCharacterName, reloadCurrentChat, removeMacros, setExtensionPrompt, substituteParams, system_avatar, system_message_types } from '../../script.js';
import { getMessageTimeStamp } from '../RossAscends-mods.js';
import { AUTOCOMPLETE_STATE, AutoComplete } from '../autocomplete/AutoComplete.js';
import { chat_completion_sources } from '../chat-completion-settings.js';
import { buildConnectApiMap } from '../connect-api-map.js';
import { getContext } from '../extensions.js';
import { getRegexedString, regex_placement } from '../extensions/regex/engine.js';
import { t } from '../i18n.js';
import { POPUP_TYPE, callGenericPopup } from '../popup.js';
import { power_user } from '../power-user.js';
import { SlashCommandAbortController } from './SlashCommandAbortController.js';
import { SlashCommandClosure } from './SlashCommandClosure.js';
import { SlashCommandClosureResult } from './SlashCommandClosureResult.js';
import { SlashCommandDebugController } from './SlashCommandDebugController.js';
import { SlashCommandExecutionError } from './SlashCommandExecutionError.js';
import { SlashCommandParserError } from './SlashCommandParserError.js';
import { slashCommandReturnHelper } from './SlashCommandReturnHelper.js';
import { SlashCommandScope } from './SlashCommandScope.js';
import { textgen_types } from '../textgen-settings.js';
import { accountStorage } from '../util/AccountStorage.js';
import { canUseNegativeLookbehind, debounce, delay, findChar, isTrueBoolean } from '../utils.js';

let parserInstance;
/**
 * Constructed lazily: a circular import back from SlashCommandParser.js means this module can
 * start evaluating while that class is still in its temporal dead zone, so `new` at module scope throws.
 * @returns {SlashCommandParser}
 */
function getParser() {
    if (!parserInstance) {
        parserInstance = new SlashCommandParser();
    }
    return parserInstance;
}
/**
 * @deprecated Use SlashCommandParser.addCommandObject() instead
 */
export function registerSlashCommand(...args) {
    return SlashCommandParser.addCommand(...args);
}
export function getSlashCommandsHelp(...args) {
    return getParser().getHelpString(...args);
}

export function closureToFilter(closure) {
    return async () => {
        try {
            const localClosure = closure.getCopy();
            localClosure.onProgress = () => { };
            const result = await localClosure.execute();
            return isTrueBoolean(result.pipe);
        } catch (e) {
            console.error('Error executing filter closure', e);
            return false;
        }
    };
}

/**
 * @typedef {object} ConnectAPIMap
 * @property {string} selected - API name (e.g. "textgenerationwebui", "openai")
 * @property {string?} [button] - CSS selector for the API button
 * @property {string?} [type] - API type, mostly used by text completion. (e.g. "openrouter")
 * @property {string?} [source] - API source, mostly used by chat completion. (e.g. "openai")
 */

/** @type {Record<string, ConnectAPIMap>} */
export const CONNECT_API_MAP = {};

/** @type {string[]} */
export const UNIQUE_APIS = [];

/** @type {Record<string, string>} CSS selector for the API button, keyed by `selected`. `koboldhorde` has none. */
const CONNECT_API_BUTTON_BY_SELECTED = {
    'kobold': '#api_button',
    'novel': '#api_button_novel',
    'textgenerationwebui': '#api_button_textgenerationwebui',
    'openai': '#api_button_openai',
};

export function setupConnectAPIMap() {
    const result = buildConnectApiMap(textgen_types, chat_completion_sources);
    for (const entry of Object.values(result)) {
        const button = CONNECT_API_BUTTON_BY_SELECTED[entry.selected];
        if (button) {
            entry.button = button;
        }
    }

    Object.assign(CONNECT_API_MAP, result);
    UNIQUE_APIS.push(...new Set(Object.values(CONNECT_API_MAP).map(x => x.selected)));
}

export const NARRATOR_NAME_KEY = 'narrator_name';
export const NARRATOR_NAME_DEFAULT = 'System';
export const COMMENT_NAME_DEFAULT = 'Note';
export const SCRIPT_PROMPT_KEY = 'script_inject_';

export async function generateSystemMessage(args, prompt) {
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

    if (!prompt) {
        console.warn('WARN: No prompt provided for /sysgen command');
        toastr.warning(t`You must provide a prompt for the system message`);
        return '';
    }

    const trim = isTrueBoolean(args?.trim?.toString());

    const toast = toastr.info(t`Please wait`, t`Generating...`);
    const message = await generateQuietPrompt({ quietPrompt: prompt, trimToSentence: trim });
    toastr.clear(toast);

    return await sendNarratorMessage(args, getRegexedString(message, regex_placement.SLASH_COMMAND));
}

/**
 * Checks if an argument is a string array (or undefined), and if not, throws an error
 * @param {string|SlashCommandClosure|(string|SlashCommandClosure)[]|undefined} arg The named argument to check
 * @param {string} name The name of the argument for the error message
 * @param {object} [options={}] - The optional arguments
 * @param {boolean} [options.allowUndefined=false] - Whether the argument can be undefined
 * @throws {Error} If the argument is not an array
 * @returns {string[]}
 */
export function validateArrayArgString(arg, name, { allowUndefined = true } = {}) {
    if (arg === undefined) {
        if (allowUndefined) return undefined;
        throw new Error(t`Argument "${name}" is undefined, but must be a string array`);
    }
    if (!Array.isArray(arg)) throw new Error(t`Argument "${name}" must be an array`);
    if (!arg.every(x => typeof x === 'string')) throw new Error(t`Argument "${name}" must be an array of strings`);
    return arg;
}

/**
 * Checks if an argument is a string or closure array (or undefined), and if not, throws an error
 * @param {string|SlashCommandClosure|(string|SlashCommandClosure)[]|undefined} arg The named argument to check
 * @param {string} name The name of the argument for the error message
 * @param {object} [options={}] - The optional arguments
 * @param {boolean} [options.allowUndefined=false] - Whether the argument can be undefined
 * @throws {Error} If the argument is not an array of strings or closures
 * @returns {(string|SlashCommandClosure)[]}
 */
export function validateArrayArg(arg, name, { allowUndefined = true } = {}) {
    if (arg === undefined) {
        if (allowUndefined) return [];
        throw new Error(t`Argument "${name}" is undefined, but must be an array of strings or closures`);
    }
    if (!Array.isArray(arg)) throw new Error(t`Argument "${name}" must be an array`);
    if (!arg.every(x => typeof x === 'string' || x instanceof SlashCommandClosure)) throw new Error(t`Argument "${name}" must be an array of strings or closures`);
    return arg;
}

/**
 * Retrieves the name and avatar information for a message
 *
 * The name of the character will always have precendence over the one given as argument. If you want to specify a different name for the message,
 * explicitly implement this in the code using this.
 *
 * @param {object?} character - The character object to get the avatar data for
 * @param {string?} name - The name to get the avatar data for
 * @returns {{name: string, force_avatar: string, original_avatar: string}} An object containing the name for the message, forced avatar URL, and original avatar
 */
export function getNameAndAvatarForMessage(character, name = null) {
    const isNeutralCharacter = !character && name2 === neutralCharacterName && name === neutralCharacterName;
    const currentChar = getCurrentCharacter();

    let force_avatar, original_avatar;
    if (character?.avatar === currentChar?.avatar || isNeutralCharacter) {
        // Skip forcing an avatar when the target is already the selected character in a solo chat
    } else if (character && character.avatar !== 'none') {
        force_avatar = getThumbnailUrl('avatar', character.avatar);
        original_avatar = character.avatar;
    } else {
        force_avatar = default_avatar;
        original_avatar = default_avatar;
    }

    return {
        name: character?.name || name,
        force_avatar: force_avatar,
        original_avatar: original_avatar,
    };
}

export async function sendMessageAs(args, text) {
    let name = args.name?.trim();

    if (!name) {
        const namelessWarningKey = 'sendAsNamelessWarningShown';
        if (accountStorage.getItem(namelessWarningKey) !== 'true') {
            toastr.warning(t`To avoid confusion, please use /sendas name="Character Name"`, t`Name defaulted to {{char}}`, { timeOut: 10000 });
            accountStorage.setItem(namelessWarningKey, 'true');
        }
        name = name2;
    }

    let mesText = String(text ?? '').trim();

    // Requires a regex check after the slash command is pushed to output
    mesText = getRegexedString(mesText, regex_placement.SLASH_COMMAND, { characterOverride: name });

    // Messages that do nothing but set bias will be hidden from the context
    const bias = extractMessageBias(mesText);
    const isSystem = bias && !removeMacros(mesText).length;
    const compact = isTrueBoolean(args?.compact);

    const character = findChar({ name: name });

    const avatarCharacter = args.avatar ? findChar({ name: args.avatar }) : character;
    if (args.avatar && !avatarCharacter) {
        toastr.warning(t`Character for avatar ${args.avatar} not found`);
        return '';
    }

    const { name: avatarCharName, force_avatar, original_avatar } = getNameAndAvatarForMessage(avatarCharacter, name);

    const message = {
        name: character?.name || name || avatarCharName,
        is_user: false,
        is_system: isSystem,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(mesText),
        force_avatar: force_avatar,
        original_avatar: original_avatar,
        extra: {
            bias: bias.trim().length ? bias : null,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    message.swipe_id = 0;
    message.swipes = [message.mes];
    message.swipe_info = [{
        send_date: message.send_date,
        gen_started: null,
        gen_finished: null,
        extra: {
            bias: message.extra.bias,
            gen_id: message.extra.gen_id,
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    }];

    let insertAt = Number(args.at);

    if (!isNaN(insertAt) && (insertAt < 0 || Object.is(insertAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        insertAt = chat.length + insertAt;
    }

    chat_metadata.tainted = true;

    if (!isNaN(insertAt) && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        // Mid-chain insert is a graft, not a diff-engine-visible change — see sendMessageAsUser()'s
        // own insertAt branch for the same reasoning.
        await chatOpGraft(insertAt).catch(error =>
            console.error('Could not save the inserted message:', error));
        await eventSource.emit(event_types.MESSAGE_RECEIVED, insertAt, 'command');
        await reloadCurrentChat();
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, insertAt, 'command');
    } else {
        const newIndex = chat.length;
        chat.push(message);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, (chat.length - 1), 'command');
        addOneMessage(message);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, (chat.length - 1), 'command');
        await chatOpAppend(newIndex).catch(error =>
            console.error('Could not save the new message:', error));
    }

    return await slashCommandReturnHelper.doReturn(args.return ?? 'none', message, { objectToStringFunc: x => x.mes });
}

export async function sendNarratorMessage(args, text) {
    text = String(text ?? '');
    const name = args.name ?? (chat_metadata[NARRATOR_NAME_KEY] || NARRATOR_NAME_DEFAULT);
    // Messages that do nothing but set bias will be hidden from the context
    const bias = extractMessageBias(text);
    const isSystem = bias && !removeMacros(text).length;
    const compact = isTrueBoolean(args?.compact);

    const message = {
        name: name,
        is_user: false,
        is_system: isSystem,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(text.trim()),
        force_avatar: system_avatar,
        extra: {
            type: system_message_types.NARRATOR,
            bias: bias.trim().length ? bias : null,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    let insertAt = Number(args.at);

    if (!isNaN(insertAt) && (insertAt < 0 || Object.is(insertAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        insertAt = chat.length + insertAt;
    }

    chat_metadata.tainted = true;

    if (!isNaN(insertAt) && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        // Mid-chain insert is a graft, not a diff-engine-visible change — see sendMessageAsUser()'s
        // own insertAt branch for the same reasoning.
        await chatOpGraft(insertAt).catch(error =>
            console.error('Could not save the inserted message:', error));
        await eventSource.emit(event_types.MESSAGE_SENT, insertAt);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, insertAt);
    } else {
        const newIndex = chat.length;
        chat.push(message);
        await eventSource.emit(event_types.MESSAGE_SENT, (chat.length - 1));
        addOneMessage(message);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, (chat.length - 1));
        await chatOpAppend(newIndex).catch(error =>
            console.error('Could not save the new message:', error));
    }

    return await slashCommandReturnHelper.doReturn(args.return ?? 'none', message, { objectToStringFunc: x => x.mes });
}

export async function promptQuietForLoudResponse(who, text) {
    // Captured once by avatar before the generateQuietPrompt() await, so a later selection change can't affect it.
    const character = getCurrentCharacter();
    if (who === 'sys') {
        text = 'System: ' + text;
    } else if (who === 'user') {
        text = name1 + ': ' + text;
    } else if (who === 'char') {
        text = character.name + ': ' + text;
    } else if (who === 'raw') {
    }

    //text = `${text}${power_user.instruct.enabled ? '' : '\n'}${(power_user.always_force_name2 && who != 'raw') ? character.name + ":" : ""}`

    let reply = await generateQuietPrompt({ quietPrompt: text, quietToLoud: true });
    text = await getRegexedString(reply, regex_placement.SLASH_COMMAND);

    const message = {
        name: character.name,
        is_user: false,
        is_name: true,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(text.trim()),
        extra: {
            type: system_message_types.COMMENT,
            gen_id: Date.now(),
            api: 'manual',
            model: 'slash command',
        },
    };

    chat_metadata.tainted = true;

    const newIndex = chat.length;
    chat.push(message);
    await eventSource.emit(event_types.MESSAGE_SENT, (chat.length - 1));
    addOneMessage(message);
    await eventSource.emit(event_types.USER_MESSAGE_RENDERED, (chat.length - 1));
    await chatOpAppend(newIndex).catch(error =>
        console.error('Could not save the new message:', error));
}

export function processChatSlashCommands() {
    const context = getContext();

    if (!(context.chatMetadata.script_injects)) {
        return;
    }

    for (const id of Object.keys(context.extensionPrompts)) {
        if (!id.startsWith(SCRIPT_PROMPT_KEY)) {
            continue;
        }

        console.log('Removing script injection', id);
        delete context.extensionPrompts[id];
    }

    for (const [id, inject] of Object.entries(context.chatMetadata.script_injects)) {
        /**
         * Rehydrates a filter closure from a string.
         * @returns {SlashCommandClosure | null}
         */
        function reviveFilterClosure() {
            if (!inject.filter) {
                return null;
            }

            try {
                return new SlashCommandParser().parse(inject.filter, true);
            } catch (error) {
                console.warn('Failed to revive filter closure for script injection', id, error);
                return null;
            }
        }

        const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;
        const filterClosure = reviveFilterClosure();
        const filter = filterClosure ? closureToFilter(filterClosure) : null;
        console.log('Adding script injection', id);
        setExtensionPrompt(prefixedId, inject.value, inject.position, inject.depth, inject.scan, inject.role, filter);
    }
}

/**
 * Clear up command execution progress bar above chat input.
 * @returns Promise<void>
 */
async function clearCommandProgress() {
    if (isExecutingCommandsFromChatInput) return;
    const ta = document.getElementById('send_textarea');
    const fs = document.getElementById('form_sheld');
    if (!ta || !fs) return;
    ta.style.setProperty('--progDone', '1');
    await delay(250);
    if (isExecutingCommandsFromChatInput) return;
    ta.style.transition = 'none';
    await delay(1);
    ta.style.setProperty('--prog', '0%');
    ta.style.setProperty('--progDone', '0');
    fs.classList.remove('script_success');
    fs.classList.remove('script_error');
    fs.classList.remove('script_aborted');
    await delay(1);
    ta.style.transition = null;
}

const clearCommandProgressDebounced = debounce(clearCommandProgress);

export let isExecutingCommandsFromChatInput = false;

export let commandsFromChatInputAbortController;

/**
 * Show command execution pause/stop buttons next to chat input.
 */
export function activateScriptButtons() {
    document.querySelector('#form_sheld').classList.add('isExecutingCommandsFromChatInput');
}

/**
 * Hide command execution pause/stop buttons next to chat input.
 */
export function deactivateScriptButtons() {
    document.querySelector('#form_sheld').classList.remove('isExecutingCommandsFromChatInput');
}

/**
 * Toggle pause/continue command execution. Only for commands executed via chat input.
 */
export function pauseScriptExecution() {
    if (commandsFromChatInputAbortController) {
        if (commandsFromChatInputAbortController.signal.paused) {
            commandsFromChatInputAbortController.continue('Clicked pause button');
            document.querySelector('#form_sheld').classList.remove('script_paused');
        } else {
            commandsFromChatInputAbortController.pause('Clicked pause button');
            document.querySelector('#form_sheld').classList.add('script_paused');
        }
    }
}

/**
 * Stop command execution. Only for commands executed via chat input.
 */
export function stopScriptExecution() {
    commandsFromChatInputAbortController?.abort('Clicked stop button');
}

/**
 * @typedef ExecuteSlashCommandsOptions
 * @prop {boolean} [handleParserErrors] (true) Whether to handle parser errors (show toast on error) or throw.
 * @prop {SlashCommandScope} [scope] (null) The scope to be used when executing the commands.
 * @prop {boolean} [handleExecutionErrors] (false) Whether to handle execution errors (show toast on error) or throw
 * @prop {import('./SlashCommandParser.js').ParserFlags} [parserFlags] (null) Parser flags to apply
 * @prop {SlashCommandAbortController} [abortController] (null) Controller used to abort or pause command execution
 * @prop {SlashCommandDebugController} [debugController] (null) Controller used to control debug execution
 * @prop {(done:number, total:number)=>void} [onProgress] (null) Callback to handle progress events
 * @prop {string} [source] (null) String indicating where the code come from (e.g., QR name)
 */

/**
 * @typedef ExecuteSlashCommandsOnChatInputOptions
 * @prop {SlashCommandScope} [scope] (null) The scope to be used when executing the commands.
 * @prop {import('./SlashCommandParser.js').ParserFlags} [parserFlags] (null) Parser flags to apply
 * @prop {boolean} [clearChatInput] (false) Whether to clear the chat input textarea
 * @prop {string} [source] (null) String indicating where the code come from (e.g., QR name)
 */

/**
 * Execute slash commands while showing progress indicator and pause/stop buttons on
 * chat input.
 * @param {string} text Slash command text
 * @param {ExecuteSlashCommandsOnChatInputOptions} options
 */
export async function executeSlashCommandsOnChatInput(text, options = {}) {
    if (isExecutingCommandsFromChatInput) return null;

    options = Object.assign({
        scope: null,
        parserFlags: null,
        clearChatInput: false,
        source: null,
    }, options);

    isExecutingCommandsFromChatInput = true;
    commandsFromChatInputAbortController?.abort('processCommands was called');
    activateScriptButtons();

    /** @type {HTMLTextAreaElement} */
    const ta = document.querySelector('#send_textarea');
    const fs = document.querySelector('#form_sheld');

    if (options.clearChatInput) {
        ta.value = '';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    ta.style.setProperty('--prog', '0%');
    ta.style.setProperty('--progDone', '0');
    fs.classList.remove('script_success');
    fs.classList.remove('script_error');
    fs.classList.remove('script_aborted');

    /**@type {SlashCommandClosureResult} */
    let result = null;
    let currentProgress = 0;
    try {
        commandsFromChatInputAbortController = new SlashCommandAbortController();
        result = await executeSlashCommandsWithOptions(text, {
            abortController: commandsFromChatInputAbortController,
            onProgress: (done, total) => {
                const newProgress = done / total;
                if (newProgress > currentProgress) {
                    currentProgress = newProgress;
                    ta.style.setProperty('--prog', `${newProgress * 100}%`);
                }
            },
            parserFlags: options.parserFlags,
            scope: options.scope,
            source: options.source,
        });
        if (commandsFromChatInputAbortController.signal.aborted) {
            document.querySelector('#form_sheld').classList.add('script_aborted');
        } else {
            document.querySelector('#form_sheld').classList.add('script_success');
        }
    } catch (e) {
        document.querySelector('#form_sheld').classList.add('script_error');
        result = new SlashCommandClosureResult();
        result.isError = true;
        result.errorMessage = e.message || t`An unknown error occurred`;
        if (e.cause !== 'abort') {
            if (e instanceof SlashCommandExecutionError) {
                /**@type {SlashCommandExecutionError}*/
                const ex = e;
                const toast = `
                    <div>${ex.message}</div>
                    <div>${t`Line`}: ${ex.line} ${t`Column`}: ${ex.column}</div>
                    <pre style="text-align:left;">${ex.hint}</pre>
                    `;
                const clickHint = `<p>${t`Click to see details`}</p>`;
                toastr.error(
                    `${toast}${clickHint}`,
                    'Slash Command Execution Error',
                    { escapeHtml: false, timeOut: 10000, onclick: () => callGenericPopup(toast, POPUP_TYPE.TEXT, '', { allowHorizontalScrolling: true, allowVerticalScrolling: true }) },
                );
            } else {
                toastr.error(result.errorMessage);
            }
        }
    } finally {
        delay(1000).then(() => clearCommandProgressDebounced());

        commandsFromChatInputAbortController = null;
        deactivateScriptButtons();
        isExecutingCommandsFromChatInput = false;
    }
    return result;
}

/**
 *
 * @param {HTMLTextAreaElement} textarea The textarea to receive autocomplete
 * @param {Boolean} isFloating Whether to show the auto complete as a floating window (e.g., large QR editor)
 * @returns {Promise<AutoComplete>}
 */
export async function setSlashCommandAutoComplete(textarea, isFloating = false) {
    if (!canUseNegativeLookbehind()) {
        console.warn('Cannot use negative lookbehind in this browser');
        return;
    }

    const parser = new SlashCommandParser();
    const ac = new AutoComplete(
        textarea,
        () => ac.text[0] == '/' && (power_user.stscript.autocomplete.state === AUTOCOMPLETE_STATE.ALWAYS || power_user.stscript.autocomplete.state === AUTOCOMPLETE_STATE.MIN_LENGTH && ac.text.length > 2),
        async (text, index) => await parser.getNameAt(text, index),
        isFloating,
    );
    return ac;
}

export async function initSlashCommandAutoComplete() {
    const sendTextarea = /** @type {HTMLTextAreaElement} */ (document.querySelector('#send_textarea'));
    setSlashCommandAutoComplete(sendTextarea);
    sendTextarea.addEventListener('input', () => {
        if (sendTextarea.value && sendTextarea.value[0] == '/') {
            sendTextarea.style.fontFamily = 'var(--monoFontFamily, monospace)';
        } else {
            sendTextarea.style.fontFamily = null;
        }
    });
}

/**
 *
 * @param {string} text Slash command text
 * @param {ExecuteSlashCommandsOptions} [options]
 * @returns {Promise<SlashCommandClosureResult>}
 */
export async function executeSlashCommandsWithOptions(text, options = {}) {
    if (!text) {
        return null;
    }
    options = Object.assign({
        handleParserErrors: true,
        scope: null,
        handleExecutionErrors: false,
        parserFlags: null,
        abortController: null,
        debugController: null,
        onProgress: null,
        source: null,
    }, options);

    let closure;
    try {
        closure = getParser().parse(text, true, options.parserFlags, options.abortController ?? new SlashCommandAbortController());
        closure.scope.parent = options.scope;
        closure.onProgress = options.onProgress;
        closure.debugController = options.debugController;
        closure.source = options.source;
    } catch (e) {
        if (options.handleParserErrors && e instanceof SlashCommandParserError) {
            /**@type {SlashCommandParserError}*/
            const ex = e;
            const toast = `
                <div>${ex.message}</div>
                <div>${t`Line`}: ${ex.line} ${t`Column`}: ${ex.column}</div>
                <pre style="text-align:left;">${ex.hint}</pre>
                `;
            const clickHint = `<p>${t`Click to see details`}</p>`;
            toastr.error(
                `${toast}${clickHint}`,
                'SlashCommandParserError',
                { escapeHtml: false, timeOut: 10000, onclick: () => callGenericPopup(toast, POPUP_TYPE.TEXT, '', { allowHorizontalScrolling: true, allowVerticalScrolling: true }) },
            );
            const result = new SlashCommandClosureResult();
            return result;
        } else {
            throw e;
        }
    }

    try {
        const result = await closure.execute();
        if (result.isAborted && !result.isQuietlyAborted) {
            toastr.warning(result.abortReason, t`Command execution aborted`);
            closure.abortController.signal.isQuiet = true;
        }
        return result;
    } catch (e) {
        if (options.handleExecutionErrors) {
            if (e instanceof SlashCommandExecutionError) {
                /**@type {SlashCommandExecutionError}*/
                const ex = e;
                const toast = `
                    <div>${ex.message}</div>
                    <div>Line: ${ex.line} Column: ${ex.column}</div>
                    <pre style="text-align:left;">${ex.hint}</pre>
                    `;
                const clickHint = '<p>Click to see details</p>';
                toastr.error(
                    `${toast}${clickHint}`,
                    'SlashCommandExecutionError',
                    { escapeHtml: false, timeOut: 10000, onclick: () => callGenericPopup(toast, POPUP_TYPE.TEXT, '', { allowHorizontalScrolling: true, allowVerticalScrolling: true }) },
                );
            } else {
                toastr.error(e.message);
            }
            const result = new SlashCommandClosureResult();
            result.isError = true;
            result.errorMessage = e.message;
            return result;
        } else {
            throw e;
        }
    }
}

/**
 * Executes slash commands in the provided text
 * @deprecated Use executeSlashCommandWithOptions instead
 * @param {string} text Slash command text
 * @param {boolean} handleParserErrors Whether to handle parser errors (show toast on error) or throw
 * @param {SlashCommandScope} scope The scope to be used when executing the commands.
 * @param {boolean} handleExecutionErrors Whether to handle execution errors (show toast on error) or throw
 * @param {{[id:import('./SlashCommandParser.js').PARSER_FLAG]:boolean}} parserFlags Parser flags to apply
 * @param {SlashCommandAbortController} abortController Controller used to abort or pause command execution
 * @param {(done:number, total:number)=>void} onProgress Callback to handle progress events
 * @returns {Promise<SlashCommandClosureResult>}
 */
export async function executeSlashCommands(text, handleParserErrors = true, scope = null, handleExecutionErrors = false, parserFlags = null, abortController = null, onProgress = null) {
    return executeSlashCommandsWithOptions(text, {
        handleParserErrors,
        scope,
        handleExecutionErrors,
        parserFlags,
        abortController,
        onProgress,
    });
}
