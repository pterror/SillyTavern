/**
 * Installed in the page before its own scripts run: once the app has loaded, `stTest.context()` gives the tests
 * the page's state and actions they read and drive, from the app's own modules.
 */
export function installTestContext() {
    if (!location.protocol.startsWith('http') || location.pathname.startsWith('/login')) return;
    /** @type {Record<string, any> | null} */
    let modules = null;
    /** @type {unknown} */
    let failure = null;
    const load = async () => {
        const script = await import('/script.js');
        const chatState = await import('/scripts/chat-state.js');
        const characterStore = await import('/scripts/character-store.js');
        const characterList = await import('/scripts/character-list.js');
        const groupChats = await import('/scripts/group-chats.js');
        const appSelection = await import('/scripts/app-selection-state.js');
        const generationParams = await import('/scripts/generation-params.js');
        const requestHeaders = await import('/scripts/request-headers.js');
        const slashCommands = await import('/scripts/slash-commands.js');
        const slashCommandParser = await import('/scripts/slash-commands/SlashCommandParser.js');
        const variables = await import('/scripts/variables.js');
        const events = await import('/scripts/events.js');
        const chatCompletion = await import('/scripts/chat-completion-settings.js');
        const textgen = await import('/scripts/textgen-settings.js');
        const powerUser = await import('/scripts/power-user.js');
        const presetManager = await import('/scripts/preset-manager.js');
        const tags = await import('/scripts/tags.js');
        const helpRegistry = await import('/scripts/help-registry.js');
        const popup = await import('/scripts/popup.js');
        const chatStore = await import('/scripts/chat-store.js');
        const metadataStore = await import('/scripts/metadata-store.js');
        const accountStorage = await import('/scripts/util/AccountStorage.js');
        modules = {
            get chat() { return chatState.chat; },
            get chatMetadata() { return chatState.chat_metadata; },
            get characters() { return characterStore.characters; },
            get characterId() {
                const avatar = script.getCurrentCharacter()?.avatar;
                const index = avatar === undefined ? -1 : characterStore.characters.findIndex(character => character.avatar === avatar);
                return index === -1 ? undefined : String(index);
            },
            get characterAvatar() { return script.getCurrentCharacter()?.avatar; },
            get groupId() { return groupChats.selected_group; },
            get name1() { return appSelection.name1; },
            get name2() { return script.name2; },
            get onlineStatus() { return script.online_status; },
            get mainApi() { return generationParams.main_api; },
            accountStorage: accountStorage.accountStorage,
            getRequestHeaders: requestHeaders.getRequestHeaders,
            getCharacters: characterList.getCharacters,
            getCharacterByAvatar: (/** @type {string} */ avatar) => characterStore.charactersStore.get(avatar),
            selectCharacterById: (/** @type {string} */ avatar) => script.selectCharacterByAvatar(avatar),
            getCurrentChatId: script.getCurrentChatId,
            executeSlashCommandsWithOptions: slashCommands.executeSlashCommandsWithOptions,
            SlashCommandParser: slashCommandParser.SlashCommandParser,
            variables: { local: variables.localVariables, global: variables.globalVariables },
            eventSource: events.eventSource,
            eventTypes: events.event_types,
            chatCompletionSettings: chatCompletion.oai_settings,
            textCompletionSettings: textgen.textgenerationwebui_settings,
            powerUserSettings: powerUser.power_user,
            getPresetManager: presetManager.getPresetManager,
            addOneMessage: script.addOneMessage,
            generate: script.Generate,
            generateQuietPrompt: script.generateQuietPrompt,
            stopGeneration: script.stopGeneration,
            saveSettingsDebounced: script.saveSettingsDebounced,
            saveMetadata: metadataStore.saveMetadata,
            updateMessageBlock: script.updateMessageBlock,
            editMessage: chatStore.chatOpEdit,
            registerHotkey: helpRegistry.registerHotkey,
            registerHelpTopic: helpRegistry.registerHelpTopic,
            getTagById: (/** @type {string} */ id) => tags.tagsStore.get(id),
            callGenericPopup: popup.callGenericPopup,
        };
    };
    document.addEventListener('DOMContentLoaded', () => {
        load().catch(error => {
            failure = error;
            console.error('The test context could not load:', error);
        });
    });
    window['stTest'] = {
        ready: () => modules !== null || failure !== null,
        context: () => {
            if (failure) throw new Error(`The test context could not load: ${failure}`);
            if (!modules) throw new Error('The test context is not loaded yet');
            return modules;
        },
    };
}
