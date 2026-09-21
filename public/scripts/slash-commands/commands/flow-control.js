import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { DOMPurify, Fuse } from '../../../lib.js';
import { chat, sendSystemMessage, system_message_types } from '../../../script.js';
import { t } from '../../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../popup.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { SlashCommandBreakController } from '../SlashCommandBreakController.js';
import { SlashCommandClosure } from '../SlashCommandClosure.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { SlashCommandNamedArgumentAssignment } from '../SlashCommandNamedArgumentAssignment.js';
import { delay, isFalseBoolean, isTrueBoolean, stringToRange } from '../../utils.js';
import { resolveVariable } from '../../variables.js';

function setInputCallback(_, value) {
    $('#send_textarea').val(value || '')[0].dispatchEvent(new Event('input', { bubbles: true }));
    return value;
}

/**
 * @typedef {object} ButtonLabel
 * @property {string} text - The button text
 * @property {string} [tooltip] - Optional tooltip text
 * @property {string} [icon] - Optional Font Awesome icon class (e.g., 'fa-floppy-disk')
 */

/**
 * @param {object} args - Named arguments for the command
 * @param {string} args.labels - JSON string of an array of button labels (strings or ButtonLabel objects)
 * @param {string} [args.multiple=false] - Flag indicating if multiple buttons can be toggled
 * @param {string} text - The text content to be displayed within the popup
 *
 * @returns {Promise<string>} - A promise that resolves to a string of the button labels selected
 *                              If 'multiple' is true, returns a JSON string array of labels.
 *                              If 'multiple' is false, returns a single label string.
 */
async function buttonsCallback(args, text) {
    try {
        /** @type {(string|ButtonLabel)[]} */
        const rawButtons = JSON.parse(resolveVariable(args?.labels));

        if (!Array.isArray(rawButtons) || !rawButtons.length) {
            console.warn('WARN: Invalid labels provided for /buttons command');
            return '';
        }

        /** @type {ButtonLabel[]} */
        const buttons = rawButtons.map(btn => typeof btn === 'string' ? { text: btn } : btn);

        // Validate raw buttons: each entry must be a string or a non-null object with a string `text` field that has content
        if (!buttons.every(btn => typeof btn === 'object' && btn !== null && typeof btn.text === 'string' && btn.text)) {
            console.warn('WARN: Invalid button label entry provided for /buttons command: each entry must be a string or an object with a "text" property');
            return '';
        }

        /** @type {Set<number>} */
        const multipleToggledState = new Set();
        const multiple = isTrueBoolean(args?.multiple);

        // Custom buttons start at 2; 1 and 0 are reserved for ok and cancel
        /** @type {Map<number, ButtonLabel>} */
        const resultToButtonMap = new Map(buttons.map((button, index) => [index + 2, button]));

        return new Promise(async (resolve) => {
            const safeValue = DOMPurify.sanitize(text || '');

            /** @type {Popup} */
            let popup;

            const buttonContainer = document.createElement('div');
            buttonContainer.classList.add('flex-container', 'flexFlowColumn', 'wide100p');

            const scrollableContainer = document.createElement('div');
            scrollableContainer.classList.add('scrollable-buttons-container');

            for (const [result, button] of resultToButtonMap) {
                const buttonElement = document.createElement('div');
                buttonElement.classList.add('menu_button', 'wide100p');

                if (multiple) {
                    buttonElement.classList.add('toggleable');
                    buttonElement.dataset.toggleValue = String(result);
                    buttonElement.addEventListener('click', async () => {
                        buttonElement.classList.toggle('toggled');
                        if (buttonElement.classList.contains('toggled')) {
                            multipleToggledState.add(result);
                        } else {
                            multipleToggledState.delete(result);
                        }
                    });
                } else {
                    buttonElement.classList.add('result-control');
                    buttonElement.dataset.result = String(result);
                }

                if (button.icon) {
                    const icon = document.createElement('i');
                    icon.className = `fa-solid ${button.icon}`;
                    icon.style.marginRight = '0.5em';
                    buttonElement.appendChild(icon);
                    const textSpan = document.createElement('span');
                    textSpan.textContent = button.text;
                    buttonElement.appendChild(textSpan);
                } else {
                    buttonElement.innerText = button.text;
                }

                if (button.tooltip) {
                    buttonElement.title = button.tooltip;
                    buttonElement.dataset.i18n = '[title]' + button.tooltip;
                }

                buttonContainer.appendChild(buttonElement);
            }

            scrollableContainer.appendChild(buttonContainer);

            const popupContainer = document.createElement('div');
            popupContainer.innerHTML = safeValue;
            popupContainer.appendChild(scrollableContainer);

            popupContainer.style.display = 'flex';
            popupContainer.style.flexDirection = 'column';
            popupContainer.style.maxHeight = '80vh';

            popup = new Popup(popupContainer, POPUP_TYPE.TEXT, '', { okButton: multiple ? t`Ok` : t`Cancel`, allowVerticalScrolling: true });
            popup.show()
                .then((result => resolve(getResult(result))))
                .catch(() => resolve(''));

            /** @returns {string} @param {string|number|boolean} result */
            function getResult(result) {
                if (multiple) {
                    const array = result === POPUP_RESULT.AFFIRMATIVE ? Array.from(multipleToggledState).map(r => resultToButtonMap.get(r)?.text ?? '') : [];
                    return JSON.stringify(array);
                }
                return typeof result === 'number' ? resultToButtonMap.get(result)?.text ?? '' : '';
            }
        });
    } catch {
        return '';
    }
}

async function popupCallback(args, value) {
    const safeBody = DOMPurify.sanitize(value || '');
    const safeHeader = args?.header && typeof args?.header === 'string' ? DOMPurify.sanitize(args.header) : null;
    const requestedResult = isTrueBoolean(args?.result);

    /** @type {import('../../popup.js').PopupOptions} */
    const popupOptions = {
        allowVerticalScrolling: !isFalseBoolean(args?.scroll),
        large: isTrueBoolean(args?.large),
        wide: isTrueBoolean(args?.wide),
        wider: isTrueBoolean(args?.wider),
        transparent: isTrueBoolean(args?.transparent),
        okButton: args?.okButton !== undefined && typeof args?.okButton === 'string' ? args.okButton : t`OK`,
        cancelButton: args?.cancelButton !== undefined && typeof args?.cancelButton === 'string' ? args.cancelButton : null,
        tooltip: args?.tooltip !== undefined && typeof args?.tooltip === 'string' ? args.tooltip : null,
    };
    const result = await Popup.show.text(safeHeader, safeBody, popupOptions);
    return String(requestedResult ? result ?? '' : value);
}

async function getMessagesCallback(args, value) {
    const includeNames = !isFalseBoolean(args?.names);
    const includeHidden = isTrueBoolean(args?.hidden);
    const role = args?.role;
    const range = stringToRange(value, 0, chat.length - 1);

    if (!range) {
        console.warn(`WARN: Invalid range provided for /messages command: ${value}`);
        return '';
    }

    const filterByRole = (mes) => {
        if (!role) {
            return true;
        }

        const isNarrator = mes.extra?.type === system_message_types.NARRATOR;

        if (role === 'system') {
            return isNarrator && !mes.is_user;
        }

        if (role === 'assistant') {
            return !isNarrator && !mes.is_user;
        }

        if (role === 'user') {
            return !isNarrator && mes.is_user;
        }

        throw new Error(t`Invalid role provided. Expected one of: system, assistant, user. Got: ${role}`);
    };

    const processMessage = async (mesId) => {
        const msg = chat[mesId];
        if (!msg) {
            console.warn(`WARN: No message found with ID ${mesId}`);
            return null;
        }

        if (role && !filterByRole(msg)) {
            return null;
        }

        if (!includeHidden && msg.is_system) {
            return null;
        }

        return includeNames ? `${msg.name}: ${msg.mes}` : msg.mes;
    };

    const messagePromises = [];

    for (let rInd = range.start; rInd <= range.end; ++rInd)
        messagePromises.push(processMessage(rInd));

    const messages = await Promise.all(messagePromises);

    return messages.filter(m => m !== null).join('\n\n');
}

async function runCallback(args, name) {
    if (!name) {
        throw new Error(t`No name provided for /run command`);
    }

    if (name instanceof SlashCommandClosure) {
        name.breakController = new SlashCommandBreakController();
        return (await name.execute())?.pipe;
    }

    /**@type {import('../SlashCommandScope.js').SlashCommandScope} */
    const scope = args._scope;
    if (scope.existsVariable(name)) {
        const closure = scope.getVariable(name);
        if (!(closure instanceof SlashCommandClosure)) {
            throw new Error(t`"${name}" is not callable.`);
        }
        closure.scope.parent = scope;
        closure.breakController = new SlashCommandBreakController();
        if (args._debugController && !closure.debugController) {
            closure.debugController = args._debugController;
        }
        while (closure.providedArgumentList.pop());
        closure.argumentList.forEach(arg => {
            if (Object.keys(args).includes(arg.name)) {
                const providedArg = new SlashCommandNamedArgumentAssignment();
                providedArg.name = arg.name;
                providedArg.value = args[arg.name];
                closure.providedArgumentList.push(providedArg);
            }
        });
        const result = await closure.execute();
        return result.pipe;
    }

    if (typeof globalThis.executeQuickReplyByName !== 'function') {
        throw new Error(t`Quick Reply extension is not loaded`);
    }

    try {
        name = name.trim();
        /**@type {import('../core.js').ExecuteSlashCommandsOptions} */
        const options = {
            abortController: args._abortController,
            debugController: args._debugController,
        };
        return await globalThis.executeQuickReplyByName(name, args, options);
    } catch (error) {
        throw new Error(t`Error running Quick Reply "${name}": ${error.message}`);
    }
}

async function delayCallback(_, amount) {
    if (!amount) {
        console.warn('WARN: No amount provided for /delay command');
        return '';
    }

    amount = Number(amount);
    if (isNaN(amount)) {
        amount = 0;
    }

    await delay(amount);
    return '';
}

async function inputCallback(args, prompt) {
    const safeValue = DOMPurify.sanitize(prompt || '');
    const defaultInput = args?.default !== undefined && typeof args?.default === 'string' ? args.default : '';
    const popupOptions = {
        large: isTrueBoolean(args?.large),
        wide: isTrueBoolean(args?.wide),
        okButton: args?.okButton !== undefined && typeof args?.okButton === 'string' ? args.okButton : t`Ok`,
        rows: args?.rows !== undefined && typeof args?.rows === 'string' ? isNaN(Number(args.rows)) ? 4 : Number(args.rows) : 4,
        placeholder: args?.placeholder !== undefined && typeof args?.placeholder === 'string' ? args.placeholder : null,
        tooltip: args?.tooltip !== undefined && typeof args?.tooltip === 'string' ? args.tooltip : null,
    };
    // Do not remove this delay: the prompt will not show up without it
    await delay(1);
    const result = await callGenericPopup(safeValue, POPUP_TYPE.INPUT, defaultInput, popupOptions);
    await delay(1);

    // Input will return null on nothing entered, and false on cancel clicked
    if (result === null || result === false) {
        if (args?.onCancel) {
            if (!(args.onCancel instanceof SlashCommandClosure)) {
                throw new Error(t`argument 'onCancel' must be a closure for command /input`);
            }
            await args.onCancel.execute();
        }
    } else {
        if (args?.onSuccess) {
            if (!(args.onSuccess instanceof SlashCommandClosure)) {
                throw new Error(t`argument 'onSuccess' must be a closure for command /input`);
            }
            await args.onSuccess.execute();
        }
    }

    return String(result || '');
}

/**
 * Each item in "args.list" is searched within "search_item" using fuzzy search. If any matches it returns the matched "item".
 * @param {FuzzyCommandArgs} args - arguments containing "list" (JSON array) and optionaly "threshold" (float between 0.0 and 1.0)
 * @param {string} searchInValue - the string where items of list are searched
 * @returns {string} - the matched item from the list
 * @typedef {{list: string, threshold: string, mode:string}} FuzzyCommandArgs - arguments for /fuzzy command
 * @example /fuzzy list=["down","left","up","right"] "he looks up" | /echo // should return "up"
 * @link https://www.fusejs.io/
 */
function fuzzyCallback(args, searchInValue) {
    if (!searchInValue) {
        console.warn('WARN: No argument provided for /fuzzy command');
        return '';
    }

    if (!args.list) {
        console.warn('WARN: No list argument provided for /fuzzy command');
        return '';
    }

    try {
        const list = JSON.parse(resolveVariable(args.list));
        if (!Array.isArray(list)) {
            console.warn('WARN: Invalid list argument provided for /fuzzy command');
            return '';
        }

        const params = {
            includeScore: true,
            findAllMatches: true,
            ignoreLocation: true,
            threshold: 0.4,
        };
        // Low threshold is strict; near 1, almost everything matches
        if ('threshold' in args) {
            params.threshold = parseFloat(args.threshold);
            if (isNaN(params.threshold)) {
                console.warn('WARN: \'threshold\' argument must be a float between 0.0 and 1.0 for /fuzzy command');
                return '';
            }
            if (params.threshold < 0) {
                params.threshold = 0;
            }
            if (params.threshold > 1) {
                params.threshold = 1;
            }
        }

        function getFirstMatch() {
            const fuse = new Fuse([searchInValue], params);
            for (const searchItem of list) {
                const result = fuse.search(searchItem);
                if (result.length > 0) {
                    console.info('/fuzzy: first matched', searchItem);
                    return searchItem;
                }
            }

            console.info('/fuzzy: no match');
            return '';
        }

        function getBestMatch() {
            const fuse = new Fuse(list, params);
            const result = fuse.search(searchInValue);
            console.debug('/fuzzy: result', result);
            if (result.length > 0) {
                console.info('/fuzzy: best matched', result[0].item);
                return result[0].item;
            }

            console.info('/fuzzy: no match');
            return '';
        }

        switch (String(args.mode).trim().toLowerCase()) {
            case 'best':
                return getBestMatch();
            case 'first':
            default:
                return getFirstMatch();
        }
    } catch {
        console.warn('WARN: Invalid list argument provided for /fuzzy command');
        return '';
    }
}

/**
 *
 * @param {{title?: string, severity?: string, timeout?: string, extendedTimeout?: string, preventDuplicates?: string, awaitDismissal?: string, cssClass?: string, color?: string, escapeHtml?: string, onClick?: SlashCommandClosure}} args - named arguments from the slash command
 * @param {string} value - The string to echo (unnamed argument from the slash command)
 * @returns {Promise<string>} The text that was echoed
 */
async function echoCallback(args, value) {
    // toastr escapes HTML by default, so input doesn't need sanitizing here
    if (value === '') {
        console.warn('WARN: No argument provided for /echo command');
        return '';
    }

    if (args.severity && !['error', 'warning', 'success', 'info'].includes(args.severity)) {
        toastr.warning(t`Invalid severity provided for /echo command: ${args.severity}`);
        args.severity = null;
    }

    value = String(value);

    let title = args.title ? args.title : undefined;
    const severity = args.severity ? args.severity : 'info';

    /** @type {ToastrOptions} */
    const options = {};
    if (args.timeout && !isNaN(parseInt(args.timeout))) options.timeOut = parseInt(args.timeout);
    if (args.extendedTimeout && !isNaN(parseInt(args.extendedTimeout))) options.extendedTimeOut = parseInt(args.extendedTimeout);
    if (isTrueBoolean(args.preventDuplicates)) options.preventDuplicates = true;
    if (args.cssClass) options.toastClass = [options.toastClass, args.cssClass].filter(Boolean).join(' ');
    options.escapeHtml = args.escapeHtml !== undefined ? isTrueBoolean(args.escapeHtml) : true;

    let awaitDismissal = isTrueBoolean(args.awaitDismissal);
    let resolveToastDismissal;

    if (awaitDismissal) {
        options.onHidden = () => resolveToastDismissal(value);
    }
    if (args.onClick) {
        if (args.onClick instanceof SlashCommandClosure) {
            options.onclick = async () => {
                // Execute the slash command directly, with its internal scope and everything. Clear progress handler so it doesn't interfere with command execution progress.
                args.onClick.onProgress = null;
                await args.onClick.execute();
            };
        } else {
            toastr.warning(t`Invalid onClick provided for /echo command. This is not a closure`);
        }
    }

    // HTML must be sanitized when allowed, to prevent XSS
    if (!options.escapeHtml) {
        if (title) title = DOMPurify.sanitize(title, { FORBID_TAGS: ['style'] });
        value = DOMPurify.sanitize(value, { FORBID_TAGS: ['style'] });
    }

    let toast;
    switch (severity) {
        case 'error':
            toast = toastr.error(value, title, options);
            break;
        case 'warning':
            toast = toastr.warning(value, title, options);
            break;
        case 'success':
            toast = toastr.success(value, title, options);
            break;
        case 'info':
        default:
            toast = toastr.info(value, title, options);
            break;
    }

    if (args.color) {
        toast.css('background-color', args.color);
    }

    if (awaitDismissal) {
        return new Promise((resolve) => {
            resolveToastDismissal = resolve;
        });
    } else {
        return value;
    }
}

/**
 * @param {any} _ Unused
 * @param {string} type Type of help to display
 */
function helpCommandCallback(_, type) {
    switch (type?.trim()?.toLowerCase()) {
        case 'slash':
        case 'commands':
        case 'slashes':
        case 'slash commands':
        case '1':
            sendSystemMessage(system_message_types.SLASH_COMMANDS);
            break;
        case 'format':
        case 'formatting':
        case 'formats':
        case 'chat formatting':
        case '2':
            sendSystemMessage(system_message_types.FORMATTING);
            break;
        case 'hotkeys':
        case 'hotkey':
        case '3':
            sendSystemMessage(system_message_types.HOTKEYS);
            break;
        case 'macros':
        case 'macro':
        case '4':
            sendSystemMessage(system_message_types.MACROS);
            break;
        default:
            sendSystemMessage(system_message_types.HELP);
            break;
    }

    return '';
}

$(document).on('click', '[data-displayHelp]', function (e) {
    e.preventDefault();
    const page = String($(this).data('displayhelp'));
    helpCommandCallback(null, page);
});

export function registerFlowControlCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: '?',
        callback: helpCommandCallback,
        aliases: ['help'],
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: t`help topic`,
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: [
                new SlashCommandEnumValue('slash', t`slash commands (STscript)`, enumTypes.command, '/'),
                new SlashCommandEnumValue('macros', t`{{macros}} (text replacement)`, enumTypes.macro, enumIcons.macro),
                new SlashCommandEnumValue('format', t`chat/text formatting`, enumTypes.name, '★'),
                new SlashCommandEnumValue('hotkeys', t`keyboard shortcuts`, enumTypes.enum, '⏎'),
            ],
        })],
        helpString: t`Get help on macros, chat formatting and commands.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'echo',
        rawQuotes: true,
        callback: echoCallback,
        returns: t`the text`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'title', t`title of the toast message`, [ARGUMENT_TYPE.STRING], false,
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'severity',
                description: t`severity level of the toast message`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'info',
                enumProvider: () => [
                    new SlashCommandEnumValue('info', 'info', enumTypes.macro, 'ℹ️'),
                    new SlashCommandEnumValue('warning', 'warning', enumTypes.enum, '⚠️'),
                    new SlashCommandEnumValue('error', 'error', enumTypes.enum, '❗'),
                    new SlashCommandEnumValue('success', 'success', enumTypes.enum, '✅'),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'timeout',
                description: t`time in milliseconds to display the toast message. Set this and 'extendedTimeout' to 0 to show indefinitely until dismissed.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: `${toastr.options.timeOut}`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'extendedTimeout',
                description: t`time in milliseconds to display the toast message. Set this and 'timeout' to 0 to show indefinitely until dismissed.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: `${toastr.options.extendedTimeOut}`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'preventDuplicates',
                description: t`prevent duplicate toasts with the same message from being displayed.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'awaitDismissal',
                description: t`wait for the toast to be dismissed before continuing.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cssClass',
                description: t`additional CSS class to add to the toast message (e.g. for custom styling)`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'color',
                description: t`custom CSS color of the toast message. Accepts all valid CSS color values (e.g. 'red', '#FF0000', 'rgb(255, 0, 0)').<br />>Can be more customizable with the 'cssClass' argument and custom classes.`,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'escapeHtml',
                description: t`whether to escape HTML in the toast message.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onClick',
                description: t`a closure to call when the toast is clicked. This executed closure receives scope as provided in the script. Careful about possible side effects when manipulating variables and more.`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            Echoes the provided text to a toast message. Can be used to display informational messages or for pipes debugging.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/echo title="My Message" severity=warning This is a warning message</code></pre>
                </li>
                <li>
                    <pre><code>/echo color=purple This message is purple</code></pre>
                </li>
                <li>
                    <pre><code>/echo onClick={: /echo escapeHtml=false color=transparent cssClass=wider_dialogue_popup &lt;img src="/img/five.png" /&gt; :} timeout=5000 Clicking on this message within 5 seconds will open the image.</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'fuzzy',
        callback: fuzzyCallback,
        returns: t`matching item`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'list',
                description: t`list of items to match against`,
                acceptsMultiple: false,
                isRequired: true,
                typeList: [ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.VARIABLE_NAME],
                enumProvider: commonEnumProviders.variables('all'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'threshold',
                description: t`fuzzy match threshold (0.0 to 1.0)`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '0.4',
                acceptsMultiple: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: t`fuzzy match mode`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'first',
                acceptsMultiple: false,
                enumList: [
                    new SlashCommandEnumValue('first', t`first match below the threshold`, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue('best', t`best match below the threshold`, enumTypes.enum, enumIcons.default),
                ],
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text to search`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Performs a fuzzy match of each item in the <code>list</code> against the <code>text to search</code>. If any item matches, then its name is returned. If no item matches the text, no value is returned.`}
        </div>
        <div>
            ${t`The optional <code>threshold</code> (default is 0.4) allows control over the match strictness.`}
            ${t`A low value (min 0.0) means the match is very strict.`}
            ${t`At 1.0 (max) the match is very loose and will match anything.`}
        </div>
        <div>
            ${t`The optional <code>mode</code> argument allows to control the behavior when multiple items match the text.`}
            <ul>
                <li>${t`<code>first</code> (default) returns the first match below the threshold.`}</li>
                <li>${t`<code>best</code> returns the best match below the threshold.`}</li>
            </ul>
        </div>
        <div>
            ${t`The returned value passes to the next command through the pipe.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/fuzzy list=["a","b","c"] threshold=0.4 abc</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pass',
        callback: (_, arg) => {
            // We do not support arrays of closures. Arrays of strings will be send as JSON
            if (Array.isArray(arg) && arg.some(x => x instanceof SlashCommandClosure)) throw new Error(t`Command /pass does not support multiple closures`);
            if (Array.isArray(arg)) return JSON.stringify(arg);
            return arg;
        },
        returns: t`the provided value`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY, ARGUMENT_TYPE.CLOSURE], true,
            ),
        ],
        aliases: ['return'],
        helpString: `
        <div>
            <pre><span class="monospace">/pass (text)</span> – ${t`passes the text to the next command through the pipe.`}</pre>
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li><pre><code>/pass Hello world</code></pre></li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'delay',
        callback: delayCallback,
        aliases: ['wait', 'sleep'],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`milliseconds`, [ARGUMENT_TYPE.NUMBER], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Delays the next command in the pipe by the specified number of milliseconds.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/delay 1000</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'input',
        aliases: ['prompt'],
        callback: inputCallback,
        returns: t`user input`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'default',
                description: t`default value of the input field`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: t`popup window will be shown larger in height, with more space for content (input field needs to be sized via 'rows' argument)`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: commonEnumProviders.boolean('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: t`popup window will be shown wider, with a wider input field`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'off',
                enumList: commonEnumProviders.boolean('onOff')(),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: t`text for the ok button`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'Ok',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'rows',
                description: t`number of rows for the input field (lines being displayed)`,
                typeList: [ARGUMENT_TYPE.NUMBER],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'placeholder',
                description: t`placeholder text displayed in the input field when empty`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: t`tooltip text shown when hovering over the input field`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onSuccess',
                description: t`closure to execute when the ok button is clicked or the input is closed as successful (via Enter, etc)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'onCancel',
                description: t`closure to execute when the cancel button is clicked or the input is closed as cancelled (via Escape, etc)`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`text to display`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a popup with the provided text and an input field.`}
            ${t`The <code>default</code> argument is the default value of the input field, and the text argument is the text to display.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/input default="John" placeholder="Enter your name" tooltip="Your display name" What is your name?</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'run',
        aliases: ['call', 'exec'],
        callback: runCallback,
        returns: t`result of the executed closure of QR`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'args', t`named arguments`, [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.BOOLEAN, ARGUMENT_TYPE.LIST, ARGUMENT_TYPE.DICTIONARY], false, true,
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`scoped variable or qr label`,
                typeList: [ARGUMENT_TYPE.VARIABLE_NAME, ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.CLOSURE],
                isRequired: true,
                enumProvider: (executor, scope) => [
                    ...commonEnumProviders.variables('scope')(executor, scope),
                    ...(typeof globalThis.qrEnumProviderExecutables === 'function') ? globalThis.qrEnumProviderExecutables() : [],
                ],
            }),
        ],
        helpString: `
        <div>
            ${t`Runs a closure from a scoped variable, or a Quick Reply with the specified name from a currently active preset or from another preset.`}
            ${t`Named arguments can be referenced in a QR with <code>{{arg::key}}</code>.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'messages',
        callback: getMessagesCallback,
        aliases: ['message'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'names', t`show message author names`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'off', commonEnumProviders.boolean('onOff')(),
            ),
            new SlashCommandNamedArgument(
                'hidden', t`include hidden messages`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'on', commonEnumProviders.boolean('onOff')(),
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: t`filter messages by role`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`message index (starts with 0) or range`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: true,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        returns: t`the specified message or range of messages as a string`,
        helpString: `
        <div>
            ${t`Returns the specified message or range of messages as a string.`}
        </div>
        <div>
            ${t`Use the <code>hidden=off</code> argument to exclude hidden messages.`}
        </div>
        <div>
            ${t`Use the <code>role</code> argument to filter messages by role. Possible values are: system, assistant, user.`}
        </div>
        <div>
            <strong>${t`Examples:`}</strong>
            <ul>
                <li>
                    <pre><code>/messages 10</code></pre>
                    ${t`Returns the 10th message.`}
                </li>
                <li>
                    <pre><code>/messages names=on 5-10</code></pre>
                    ${t`Returns messages 5 through 10 with author names.`}
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setinput',
        callback: setInputCallback,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Sets the user input to the specified text and passes it to the next command through the pipe.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/setinput Hello world</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'popup',
        callback: popupCallback,
        returns: t`Popup text`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'scroll',
                description: t`allows vertical scrolling of the content`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'large',
                description: t`show large popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wide',
                description: t`show wide popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'wider',
                description: t`show wider popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'transparent',
                description: t`show transparent popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'okButton',
                description: t`text for the OK button`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'OK',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'cancelButton',
                description: t`text for the Cancel button`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'result',
                description: t`if enabled, returns the popup result (as an integer) instead of the popup text. Resolves to 1 for OK and 0 cancel button, empty string for exiting out.`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'tooltip',
                description: t`tooltip text shown when hovering over the popup content area`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`popup text`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a blocking popup with the specified text and buttons.`}
            ${t`Returns the popup text.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/popup large=on wide=on okButton="Confirm" Please confirm this action.</code></pre>
                </li>
                <li>
                    <pre><code>/popup okButton="Left" cancelButton="Right" result=true Do you want to go left or right? | /echo 0 means right, 1 means left. Choice: {{pipe}}</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'buttons',
        callback: buttonsCallback,
        returns: t`clicked button label (or array of labels if multiple is enabled)`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'labels',
                description: t`button labels - can be an array of strings or objects with text, tooltip, and icon properties`,
                typeList: [ARGUMENT_TYPE.LIST],
                isRequired: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'multiple',
                description: t`if enabled multiple buttons can be clicked/toggled, and all clicked buttons are returned as an array`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`text`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `
        <div>
            ${t`Shows a blocking popup with the specified text and buttons.`}
            ${t`Returns the clicked button label into the pipe or empty string if canceled.`}
        </div>
        <div>
            ${t`Labels can be simple strings or objects with <code>text</code>, <code>tooltip</code>, and <code>icon</code> (Font Awesome class) properties.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/buttons labels=["Yes","No"] Do you want to continue?</code></pre>
                </li>
                <li>
                    <pre><code>/buttons labels=[{"text":"Save","icon":"fa-floppy-disk","tooltip":"Save changes"},{"text":"Cancel"}] Choose an action</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));
}
