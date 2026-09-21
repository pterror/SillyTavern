import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { chat_metadata, extension_prompt_roles, extension_prompt_types, setExtensionPrompt } from '../../../script.js';
import { eventSource, event_types } from '../../events.js';
import { promptManager } from '../../chat-completion-settings.js';
import { saveMetadataDebounced } from '../../extensions.js';
import { t } from '../../i18n.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { SlashCommandClosure } from '../SlashCommandClosure.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { slashCommandReturnHelper } from '../SlashCommandReturnHelper.js';
import { isFalseBoolean, isTrueBoolean } from '../../utils.js';
import { SCRIPT_PROMPT_KEY, closureToFilter } from '../core.js';

function injectCallback(args, value) {
    const positions = {
        'before': extension_prompt_types.BEFORE_PROMPT,
        'after': extension_prompt_types.IN_PROMPT,
        'chat': extension_prompt_types.IN_CHAT,
        'none': extension_prompt_types.NONE,
    };
    const roles = {
        'system': extension_prompt_roles.SYSTEM,
        'user': extension_prompt_roles.USER,
        'assistant': extension_prompt_roles.ASSISTANT,
    };

    const id = String(args?.id ?? '') || Math.random().toString(36).substring(2);
    const ephemeral = isTrueBoolean(String(args?.ephemeral ?? ''));

    const defaultPosition = 'after';
    const defaultDepth = 4;
    const positionValue = args?.position ?? defaultPosition;
    const position = positions[positionValue] ?? positions[defaultPosition];
    const depthValue = Number(args?.depth ?? defaultDepth);
    const depth = isNaN(depthValue) ? defaultDepth : depthValue;
    const roleValue = typeof args?.role === 'string' ? args.role.toLowerCase().trim() : Number(args?.role ?? extension_prompt_roles.SYSTEM);
    const role = roles[roleValue] ?? extension_prompt_roles.SYSTEM;
    const scan = isTrueBoolean(String(args?.scan));
    const filter = args?.filter instanceof SlashCommandClosure ? args.filter.rawText : null;
    const filterFunction = args?.filter instanceof SlashCommandClosure ? closureToFilter(args.filter) : null;
    value = value || '';
    if (args?.filter && !String(filter ?? '').trim()) {
        throw new Error(t`Failed to parse the filter argument. Make sure it is a valid non-empty closure.`);
    }

    const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;

    if (!chat_metadata.script_injects) {
        chat_metadata.script_injects = {};
    }

    if (value) {
        const inject = { value, position, depth, scan, role, filter };
        chat_metadata.script_injects[id] = inject;
    } else {
        delete chat_metadata.script_injects[id];
    }

    setExtensionPrompt(prefixedId, String(value), position, depth, scan, role, filterFunction);
    saveMetadataDebounced();

    if (ephemeral) {
        let deleted = false;
        const unsetInject = () => {
            if (deleted) {
                return;
            }
            console.log('Removing ephemeral script injection', id);
            delete chat_metadata.script_injects[id];
            setExtensionPrompt(prefixedId, '', position, depth, scan, role, filterFunction);
            saveMetadataDebounced();
            deleted = true;
        };
        eventSource.once(event_types.GENERATION_ENDED, unsetInject);
        eventSource.once(event_types.GENERATION_STOPPED, unsetInject);
    }

    return id;
}

async function listInjectsCallback(args) {
    /** @type {import('../SlashCommandReturnHelper.js').SlashCommandReturnType} */
    let returnType = args.return;

    const buildTextValue = (injects) => {
        const injectsStr = Object.entries(injects)
            .map(([id, inject]) => {
                const position = Object.entries(extension_prompt_types);
                const positionName = position.find(([_, value]) => value === inject.position)?.[0] ?? t`unknown`;
                return `* **${id}**: <code>${inject.value}</code> (${positionName}, ${t`depth`}: ${inject.depth}, ${t`scan`}: ${inject.scan ?? false}, ${t`role`}: ${inject.role ?? extension_prompt_roles.SYSTEM})`;
            })
            .join('\n');
        return `### ${t`Script injections:`}\n${injectsStr || t`No script injections for the current chat`}`;
    };

    return await slashCommandReturnHelper.doReturn(returnType ?? 'popup-html', chat_metadata.script_injects ?? {}, { objectToStringFunc: buildTextValue });
}

/**
 * @returns {string} Empty string
 */
function flushInjectsCallback(_, value) {
    if (!chat_metadata.script_injects) {
        return '';
    }

    const idArgument = value;

    for (const [id, inject] of Object.entries(chat_metadata.script_injects)) {
        if (idArgument && id !== idArgument) {
            continue;
        }

        const prefixedId = `${SCRIPT_PROMPT_KEY}${id}`;
        setExtensionPrompt(prefixedId, '', inject.position, inject.depth, inject.scan, inject.role);
        delete chat_metadata.script_injects[id];
    }

    saveMetadataDebounced();
    return '';
}

/**
 * Gets the state of prompt entries (toggles) either via identifier/uuid or name.
 * @param {object} args Object containing arguments
 * @param {string} args.identifier Select prompt entry using an identifier (uuid)
 * @param {string} args.name Select prompt entry using name
 * @param {string} args.return The type of return value to use (simple, list, dict)
 * @returns {Object} An object containing the states of the requested prompt entries
 */
function getPromptEntryCallback(args) {
    const prompts = promptManager.serviceSettings.prompts;
    let returnType = args.return ?? 'simple';

    function parseArgs(arg) {
        if (Array.isArray(arg)) {
            return arg;
        }
        const list = [];
        try {
            const parsedArg = JSON.parse(arg);
            list.push(...Array.isArray(parsedArg) ? parsedArg : [arg]);
        } catch {
            list.push(arg);
        }
        return list;
    }

    let identifiersList = parseArgs(args.identifier);
    let nameList = parseArgs(args.name);

    if (identifiersList.length !== 0) {
        identifiersList = identifiersList.filter(identifier => prompts.some(prompt => prompt.identifier === identifier));
    }

    if (nameList.length !== 0) {
        nameList.forEach(name => {
            let identifiers = prompts
                .filter(entry => entry.name === name)
                .map(entry => entry.identifier);
            identifiersList = identifiersList.concat(identifiers);
        });
    }

    let promptStates = new Map();
    identifiersList.forEach(identifier => {
        const promptOrderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, identifier);
        if (promptOrderEntry) {
            promptStates.set(identifier, promptOrderEntry.enabled);
        }
    });

    // If return is simple (default) but more than one prompt state was retrieved, then change return type
    if (returnType === 'simple' && promptStates.size > 1) {
        returnType = args.identifier ? 'dict' : 'list';
    }

    const result = (() => {
        if (returnType === 'list') return [...promptStates.values()];
        if (returnType === 'dict') return Object.fromEntries(promptStates);
        return [...promptStates.values()][0];
    })();

    return result;
}

/**
 * Sets state of prompt entries (toggles) either via identifier/uuid or name.
 * @param {object} args Object containing arguments
 * @param {string} args.identifier Select prompt entry using an identifier (uuid)
 * @param {string} args.name Select prompt entry using name
 * @param {string} targetState The targeted state of the entry/entries
 * @returns {String} empty string
 */
function setPromptEntryCallback(args, targetState) {
    // needs promptManager to manipulate prompt entries
    const prompts = promptManager.serviceSettings.prompts;

    function parseArgs(arg) {
        if (Array.isArray(arg)) {
            return arg;
        }
        const list = [];
        try {
            const parsedArg = JSON.parse(arg);
            list.push(...Array.isArray(parsedArg) ? parsedArg : [arg]);
        } catch {
            list.push(arg);
        }
        return list;
    }

    let identifiersList = parseArgs(args.identifier);
    let nameList = parseArgs(args.name);

    if (identifiersList.length !== 0) {
        identifiersList = identifiersList.filter(identifier => prompts.some(prompt => prompt.identifier === identifier));
    }

    if (nameList.length !== 0) {
        nameList.forEach(name => {
            // A name can match multiple entries; find all matching identifiers
            let identifiers = [];
            prompts.forEach(entry => {
                if (entry.name === name) {
                    identifiers.push(entry.identifier);
                }
            });
            identifiersList = identifiersList.concat(identifiers);
        });
    }

    // Remove duplicates to allow consistent 'toggle'
    identifiersList = [...new Set(identifiersList)];
    if (identifiersList.length === 0) return '';

    const getPromptOrderEntryState = (promptOrderEntry) => {
        if (['toggle', 't', ''].includes(targetState.trim().toLowerCase())) {
            return !promptOrderEntry.enabled;
        }

        if (isTrueBoolean(targetState)) {
            return true;
        }

        if (isFalseBoolean(targetState)) {
            return false;
        }

        return promptOrderEntry.enabled;
    };

    identifiersList.forEach(promptID => {
        const promptOrderEntry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, promptID);
        const counts = promptManager.tokenHandler.getCounts();

        counts[promptID] = null;
        promptOrderEntry.enabled = getPromptOrderEntryState(promptOrderEntry);
    });

    // no need to render for each identifier
    promptManager.render();
    promptManager.saveServiceSettings();
    return '';
}

export function registerInjectsCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'inject',
        returns: t`injection ID`,
        callback: injectCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'id',
                description: t`injection ID`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.injects,
            }),
            new SlashCommandNamedArgument(
                'position', t`injection position`, [ARGUMENT_TYPE.STRING], false, false, 'after', ['before', 'after', 'chat', 'none'],
            ),
            new SlashCommandNamedArgument(
                'depth', t`injection depth`, [ARGUMENT_TYPE.NUMBER], false, false, '4',
            ),
            new SlashCommandNamedArgument(
                'scan', t`include injection content into World Info scans`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'role',
                description: t`role for in-chat injections`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: [
                    new SlashCommandEnumValue('system', null, enumTypes.enum, enumIcons.system),
                    new SlashCommandEnumValue('assistant', null, enumTypes.enum, enumIcons.assistant),
                    new SlashCommandEnumValue('user', null, enumTypes.enum, enumIcons.user),
                ],
            }),
            new SlashCommandNamedArgument(
                'ephemeral', t`remove injection after generation`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'filter',
                description: t`if a filter is defined, an injection will only be performed if the closure returns true`,
                typeList: [ARGUMENT_TYPE.CLOSURE],
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: t`Injects a text into the LLM prompt for the current chat. Requires a unique injection ID (will be auto-generated if not provided). Positions: "before" main prompt, "after" main prompt, in-"chat", hidden with "none" (default: after). Depth: injection depth for the prompt (default: 4). Role: role for in-chat injections (default: system). Scan: include injection content into World Info scans (default: false). Hidden injects in "none" position are not inserted into the prompt but can be used for triggering WI entries. Returns the injection ID.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'listinjects',
        callback: listInjectsCallback,
        helpString: t`Lists all script injections for the current chat. Displays injects in a popup by default. Use the <code>return</code> argument to change the return type.`,
        returns: t`Optionally the JSON object of script injections`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'popup-html',
                enumList: slashCommandReturnHelper.enumList({ allowPipe: false, allowObject: true, allowChat: true, allowPopup: true, allowTextVersion: false }),
                forceEnum: true,
            }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'flushinject',
        aliases: ['flushinjects'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`injection ID or a variable name pointing to ID`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '',
                enumProvider: commonEnumProviders.injects,
            }),
        ],
        callback: flushInjectsCallback,
        helpString: t`Removes a script injection for the current chat. If no ID is provided, removes all script injections.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'getpromptentry',
        aliases: ['getpromptentries'],
        callback: getPromptEntryCallback,
        returns: t`true/false state of prompt(s)`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'identifier',
                description: t`Prompt entry identifier(s) to retrieve`,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.LIST],
                acceptsMultiple: true,
                enumProvider: () =>
                    promptManager.serviceSettings.prompts
                        .map(prompt => prompt.identifier)
                        .map(identifier => new SlashCommandEnumValue(identifier)),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Prompt entry name(s) to retrieve`,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.LIST],
                acceptsMultiple: true,
                enumProvider: () =>
                    promptManager.serviceSettings.prompts
                        .map(prompt => prompt.name)
                        .map(name => new SlashCommandEnumValue(name)),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`Whether the return will be simple, a list, or a dict.`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'simple',
                enumList: ['simple', 'list', 'dict'],
            }),
        ],
        helpString: `
            <div>
                ${t`Gets the state of the specified prompt entries.`}
            </div>
            <div>
                ${t`If <code>return</code> is <code>simple</code> (default) then the return will be a single value if only one value was retrieved; otherwise uses a dict (if the identifier parameter was used) or a list.`}
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'setpromptentry',
        aliases: ['setpromptentries'],
        callback: setPromptEntryCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'identifier',
                description: t`Prompt entry identifier(s) to target`,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.LIST],
                acceptsMultiple: true,
                enumProvider: () => {
                    const prompts = promptManager.serviceSettings.prompts;
                    return prompts.map(prompt => new SlashCommandEnumValue(prompt.identifier, prompt.name, enumTypes.enum));
                },
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Prompt entry name(s) to target`,
                typeList: [ARGUMENT_TYPE.STRING, ARGUMENT_TYPE.LIST],
                acceptsMultiple: true,
                enumProvider: () => {
                    const prompts = promptManager.serviceSettings.prompts;
                    return prompts.map(prompt => new SlashCommandEnumValue(prompt.name, prompt.identifier, enumTypes.enum));
                },
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Set entry/entries on or off`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                acceptsMultiple: false,
                defaultValue: 'toggle', // unnamed arguments don't support default values yet
                enumList: commonEnumProviders.boolean('onOffToggle')(),
            }),
        ],
        helpString: t`Sets the specified prompt manager entry/entries on or off.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'pm-render',
        callback: (args, _) => {
            const dryRun = !isFalseBoolean(args?.refresh?.toString());
            promptManager.render(dryRun);
            return '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'refresh',
                description: 'Perform a dry run of the generation to refresh token counters before rendering the prompt manager',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumList: commonEnumProviders.boolean('trueFalse')(),
            }),
        ],
        helpString: t`Rerenders the prompt manager content. Use this if you have made changes to the prompt entries through slash commands and want to see the changes reflected in the prompt manager UI.`,
    }));
}
