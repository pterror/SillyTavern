import { eventSource, event_types } from './events.js';
import { registerVariableCommands } from './variables.js';
import { registerActionLoaderSlashCommands } from './action-loader-slashcommands.js';
import {
    CONNECT_API_MAP,
    COMMENT_NAME_DEFAULT,
    UNIQUE_APIS,
    activateScriptButtons,
    commandsFromChatInputAbortController,
    deactivateScriptButtons,
    executeSlashCommands,
    executeSlashCommandsOnChatInput,
    executeSlashCommandsWithOptions,
    generateSystemMessage,
    getNameAndAvatarForMessage,
    getSlashCommandsHelp,
    initSlashCommandAutoComplete,
    isExecutingCommandsFromChatInput,
    pauseScriptExecution,
    processChatSlashCommands,
    promptQuietForLoudResponse,
    registerSlashCommand,
    sendMessageAs,
    sendNarratorMessage,
    setSlashCommandAutoComplete,
    setupConnectAPIMap,
    stopScriptExecution,
    validateArrayArg,
    validateArrayArgString,
} from './slash-commands/core.js';
import { registerConnectionCommands } from './slash-commands/commands/connection.js';
import { registerCharacterCommands } from './slash-commands/commands/character.js';
import { registerChatCommands } from './slash-commands/commands/chat.js';
import { registerMessageCommands } from './slash-commands/commands/message.js';
import { registerGroupCommands } from './slash-commands/commands/group.js';
import { registerGenerationCommands } from './slash-commands/commands/generation.js';
import { registerFlowControlCommands } from './slash-commands/commands/flow-control.js';
import { registerInjectsCommands } from './slash-commands/commands/injects.js';
import { registerUiCommands } from './slash-commands/commands/ui.js';
import { registerTextUtilsCommands } from './slash-commands/commands/text-utils.js';

export {
    executeSlashCommands, executeSlashCommandsWithOptions, getSlashCommandsHelp, registerSlashCommand,
};
export {
    CONNECT_API_MAP,
    COMMENT_NAME_DEFAULT,
    UNIQUE_APIS,
    activateScriptButtons,
    commandsFromChatInputAbortController,
    deactivateScriptButtons,
    executeSlashCommandsOnChatInput,
    generateSystemMessage,
    getNameAndAvatarForMessage,
    initSlashCommandAutoComplete,
    isExecutingCommandsFromChatInput,
    pauseScriptExecution,
    processChatSlashCommands,
    promptQuietForLoudResponse,
    sendMessageAs,
    sendNarratorMessage,
    setSlashCommandAutoComplete,
    stopScriptExecution,
    validateArrayArg,
    validateArrayArgString,
};

/** @typedef {import('./slash-commands/core.js').ConnectAPIMap} ConnectAPIMap */
/** @typedef {import('./slash-commands/core.js').ExecuteSlashCommandsOptions} ExecuteSlashCommandsOptions */
/** @typedef {import('./slash-commands/core.js').ExecuteSlashCommandsOnChatInputOptions} ExecuteSlashCommandsOnChatInputOptions */

/**
 * Registers all default slash commands, grouped by domain across public/scripts/slash-commands/commands/*.js.
 * Shared execution engine, autocomplete plumbing and cross-category helpers live in public/scripts/slash-commands/core.js.
 */
export function initDefaultSlashCommands() {
    eventSource.on(event_types.CHAT_CHANGED, processChatSlashCommands);
    setupConnectAPIMap();

    registerConnectionCommands();
    registerCharacterCommands();
    registerChatCommands();
    registerMessageCommands();
    registerGroupCommands();
    registerGenerationCommands();
    registerFlowControlCommands();
    registerInjectsCommands();
    registerUiCommands();
    registerTextUtilsCommands();

    registerVariableCommands();
    registerActionLoaderSlashCommands();
}
