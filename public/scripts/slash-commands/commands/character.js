import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { Generate, deleteCharacter, duplicateCharacter, getCurrentCharacter, getThumbnailUrl, is_send_press, reloadCurrentChat, renameCharacter, saveChatConditional, selectCharacterByAvatar, select_selected_character } from '../../../script.js';
import { getCharacters, getOneCharacter } from '../../character-list.js';
import { chat } from '../../chat-state.js';
import { getRequestHeaders } from '../../request-headers.js';
import { charactersStore } from '../../character-store.js';
import { eventSource, event_types } from '../../events.js';
import { is_group_generating } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '../../popup.js';
import { power_user } from '../../power-user.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { SlashCommandClosure } from '../SlashCommandClosure.js';
import { commonEnumMatchProviders, commonEnumProviders } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { slashCommandReturnHelper } from '../SlashCommandReturnHelper.js';
import { findChar, isFalseBoolean, isTrueBoolean, resolveAvatarData, waitUntilCondition } from '../../utils.js';
import { validateArrayArgString } from '../core.js';

/**
 * Resolves a base64 avatar data URL into an uploadable Blob, optionally running it through the crop dialog first.
 * @param {string} base64Data - Base64 data URL of the image
 * @param {object} [options={}] - Options
 * @param {boolean} [options.resizePrompt=false] - Whether to show the resize/crop prompt
 * @returns {Promise<Blob|null>} The final image blob, or null if the user cancelled the crop dialog
 */
async function resolveFinalAvatarBlob(base64Data, { resizePrompt = false } = {}) {
    let finalImageData = base64Data;

    if (resizePrompt) {
        if (power_user.never_resize_avatars) {
            toastr.warning(t`Avatar resizing is disabled in settings. The image will be uploaded as-is.`);
        } else {
            const dlg = new Popup(t`Set the crop position of the avatar image`, POPUP_TYPE.CROP, '', { cropImage: base64Data });
            const croppedImage = await dlg.show();
            if (!croppedImage) {
                return null;
            }
            // The dialog returns the already-cropped image
            finalImageData = String(croppedImage);
        }
    }

    const response = await fetch(finalImageData);
    return await response.blob();
}

/**
 * Refreshes cached thumbnails and any currently-rendered `<img>` elements for a character's avatar,
 * after its underlying image file has changed on the server.
 * @param {string} avatarKey - The character's avatar filename (e.g., "name.png")
 * @returns {Promise<void>}
 */
async function refreshAvatarDisplay(avatarKey) {
    const thumbnailUrl = getThumbnailUrl('avatar', avatarKey);
    await fetch(thumbnailUrl, { method: 'GET', cache: 'reload' });
    await fetch(`/characters/${avatarKey}`, { method: 'GET', cache: 'reload' });

    // Refresh all visible avatar images that use this thumbnail URL
    // This handles messages, character list, and any other place using the thumbnail
    const avatarImages = document.querySelectorAll(`img[src^="${thumbnailUrl}"]`);
    for (const img of avatarImages) {
        if (img instanceof HTMLImageElement) {
            const originalSrc = img.src;
            img.src = '';
            img.src = originalSrc;
        }
    }
    console.debug(`Refreshed ${avatarImages.length} avatar images for ${avatarKey}`);
}

/**
 * @returns {Promise<string>} The avatar key of the created character
 */
async function createCharacterCallback(args) {
    const name = args.name;
    const description = args.description;
    const firstMessage = args.firstMessage;

    if (!name || typeof name !== 'string' || !name.trim()) {
        toastr.warning(t`Character name is required`);
        return '';
    }

    const characterData = {
        ch_name: name.trim(),
        description: description,
        first_mes: firstMessage,
        personality: args.personality ?? '',
        scenario: args.scenario ?? '',
        mes_example: args.messageExamples ?? '',
        creator_notes: args.creatorNotes ?? '',
        system_prompt: args.systemPrompt ?? '',
        post_history_instructions: args.postHistoryInstructions ?? '',
        creator: args.creator ?? '',
        character_version: args.characterVersion ?? '',
        tags: args.tags ?? '',
        talkativeness: args.talkativeness ?? '0.5',
        world: args.world ?? '',
        depth_prompt_prompt: args.depthPrompt ?? '',
        depth_prompt_depth: args.depthPromptDepth ?? '4',
        depth_prompt_role: args.depthPromptRole ?? 'system',
        fav: isTrueBoolean(args.favorite) ? 'true' : 'false',
        extensions: '{}',
    };

    const avatarData = args.avatar ? await resolveAvatarData(args.avatar) : null;
    let avatarBlob = null;
    let avatarCancelled = false;
    if (avatarData) {
        const resizePrompt = !isFalseBoolean(args.avatarPromptResize);
        avatarBlob = await resolveFinalAvatarBlob(avatarData, { resizePrompt });
        avatarCancelled = !avatarBlob;
    }

    try {
        const formData = new FormData();
        for (const [key, value] of Object.entries(characterData)) {
            formData.append(key, value ?? '');
        }
        if (avatarBlob) {
            formData.append('avatar', avatarBlob, 'avatar.png');
        }

        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText); // Will be caught and logged below
        }

        const avatarKey = await response.text();

        if (avatarCancelled) {
            // User cancelled the resize dialog, but character was still created
            toastr.info(t`Character created without avatar (resize cancelled)`);
        }

        await getCharacters();

        const shouldSelect = !isFalseBoolean(args.select);
        if (shouldSelect) {
            const newCharacter = charactersStore.get(avatarKey);
            if (newCharacter) {
                // selectCharacterByAvatar handles group reset and active character setting
                await selectCharacterByAvatar(avatarKey);
            }
        }

        toastr.success(t`Character "${name}" created successfully`);
        return avatarKey;
    } catch (error) {
        console.error('Error creating character:', error);
        toastr.error(t`Failed to create character: ${error.message}`);
        return '';
    }
}

/**
 * @returns {Promise<string>} The avatar key of the updated character
 */
async function updateCharacterCallback(args) {
    let character;
    if (args.char) {
        character = findChar({ name: args.char });
        if (!character) {
            toastr.warning(t`Character "${args.char}" not found`);
            return '';
        }
    } else {
        if (!getCurrentCharacter()) {
            toastr.warning(t`No character selected and no char argument provided`);
            return '';
        }
        character = getCurrentCharacter();
    }

    const updateData = {
        avatar: character.avatar,
    };

    const fieldMappings = {
        name: 'name',
        description: 'description',
        firstMessage: 'first_mes',
        personality: 'personality',
        scenario: 'scenario',
        messageExamples: 'mes_example',
        creatorNotes: 'creator_notes',
        systemPrompt: 'system_prompt',
        postHistoryInstructions: 'post_history_instructions',
        creator: 'creator',
        characterVersion: 'character_version',
        tags: 'tags',
    };

    let hasUpdates = false;
    for (const [argName, fieldName] of Object.entries(fieldMappings)) {
        if (args[argName] !== undefined) {
            let value = args[argName];
            if (fieldName === 'tags' && typeof value === 'string') {
                value = value.split(',').map(t => t.trim()).filter(t => t);
            }
            updateData[fieldName] = value;
            // Also set in data object for V2 spec compliance
            if (!updateData.data) updateData.data = {};
            updateData.data[fieldName] = value;
            hasUpdates = true;
        }
    }

    // Special handling for world / lorebook: store under data.extensions.world
    if (args.world !== undefined) {
        const value = args.world;
        if (!updateData.data) {
            updateData.data = {};
        }
        if (!updateData.data.extensions) {
            updateData.data.extensions = {};
        }
        updateData.data.extensions.world = value;
        hasUpdates = true;
    }

    if (args.talkativeness !== undefined) {
        const talkValue = parseFloat(args.talkativeness);
        if (!isNaN(talkValue)) {
            updateData.talkativeness = talkValue;
            if (!updateData.data) updateData.data = {};
            if (!updateData.data.extensions) updateData.data.extensions = {};
            updateData.data.extensions.talkativeness = talkValue;
            hasUpdates = true;
        }
    }

    if (args.favorite !== undefined) {
        const favValue = isTrueBoolean(args.favorite);
        updateData.fav = favValue;
        if (!updateData.data) updateData.data = {};
        if (!updateData.data.extensions) updateData.data.extensions = {};
        updateData.data.extensions.fav = favValue;
        hasUpdates = true;
    }

    // Handle avatar (resolve URL/base64, sent together with the merge request below)
    const avatarData = args.avatar ? await resolveAvatarData(args.avatar) : null;
    let avatarBlob = null;
    let avatarCancelled = false;
    if (avatarData) {
        const resizePrompt = !isFalseBoolean(args.avatarPromptResize);
        avatarBlob = await resolveFinalAvatarBlob(avatarData, { resizePrompt });
        avatarCancelled = !avatarBlob;
        hasUpdates = true;
    }

    if (args.depthPrompt !== undefined || args.depthPromptDepth !== undefined || args.depthPromptRole !== undefined) {
        if (!updateData.data) updateData.data = {};
        if (!updateData.data.extensions) updateData.data.extensions = {};
        if (!updateData.data.extensions.depth_prompt) updateData.data.extensions.depth_prompt = {};

        if (args.depthPrompt !== undefined) {
            updateData.data.extensions.depth_prompt.prompt = args.depthPrompt;
            hasUpdates = true;
        }
        if (args.depthPromptDepth !== undefined) {
            updateData.data.extensions.depth_prompt.depth = parseInt(args.depthPromptDepth);
            hasUpdates = true;
        }
        if (args.depthPromptRole !== undefined) {
            updateData.data.extensions.depth_prompt.role = args.depthPromptRole;
            hasUpdates = true;
        }
    }

    if (!hasUpdates) {
        toastr.warning(t`No fields provided to update`);
        return character.avatar;
    }

    try {
        let response;
        if (avatarBlob) {
            const formData = new FormData();
            formData.append('avatar', avatarBlob, 'avatar.png');
            formData.append('payload', JSON.stringify(updateData));
            response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: formData,
            });
        } else {
            response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify(updateData),
            });
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Server returned ${response.status}`); // Will be caught and logged below
        }

        if (avatarCancelled) {
            toastr.warning(t`Avatar update cancelled`);
        } else if (avatarBlob) {
            await refreshAvatarDisplay(character.avatar);
        }

        await getOneCharacter(character.avatar);

        // The character is looked up fresh by avatar (stable identity), since the reference
        // can change across the awaits above (avatar upload, getOneCharacter refresh)
        await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { character: charactersStore.get(character.avatar) } });

        if (character.avatar === getCurrentCharacter()?.avatar) {
            select_selected_character(character.avatar, { switchMenu: false });
        }

        toastr.success(t`Character "${character.name}" updated successfully`);
        return character.avatar;
    } catch (error) {
        console.error('Error updating character:', error);
        toastr.error(t`Failed to update character: ${error.message}`);
        return '';
    }
}

/**
 * @returns {Promise<string>} The avatar key of the duplicated character
 */
async function duplicateCharacterCallback(args) {
    let targetAvatar = null;
    if (args.char) {
        const character = findChar({ name: args.char });
        if (!character) {
            toastr.warning(t`Character "${args.char}" not found`);
            return '';
        }
        targetAvatar = character.avatar;
    }

    const newAvatarKey = await duplicateCharacter({ avatar: targetAvatar, silent: true });
    if (!newAvatarKey) {
        toastr.error(t`Failed to duplicate character`);
        return '';
    }

    const shouldSelect = isTrueBoolean(args.select);
    if (shouldSelect) {
        const newCharacter = charactersStore.get(newAvatarKey);
        if (newCharacter) {
            await selectCharacterByAvatar(newAvatarKey);
        }
    }

    return newAvatarKey;
}

/**
 * @returns {Promise<string>} Character data or field value
 */
async function getCharacterDataCallback(args) {
    let character;
    if (args.char) {
        character = findChar({ name: args.char });
        if (!character) {
            toastr.warning(t`Character "${args.char}" not found`);
            return '';
        }
    } else {
        if (!getCurrentCharacter()) {
            toastr.warning(t`No character selected and no char argument provided`);
            return '';
        }
        character = getCurrentCharacter();
    }

    if (args.field) {
        const fieldName = args.field;

        // Try to get from data object first (V2 spec), then fall back to root
        let value = character.data?.[fieldName] ?? character[fieldName];

        if (fieldName === 'talkativeness') {
            value = character.data?.extensions?.talkativeness ?? character.talkativeness ?? 0.5;
        }
        if (fieldName === 'tags') {
            value = character.data?.tags ?? character.tags ?? [];
            if (Array.isArray(value)) {
                value = value.join(', ');
            }
        }

        if (value === undefined) {
            return '';
        }

        return await slashCommandReturnHelper.doReturn(args.return ?? 'pipe', value, { objectToStringFunc: x => String(x) });
    }

    const charData = {
        avatar: character.avatar,
        name: character.name,
        description: character.description ?? character.data?.description ?? '',
        personality: character.personality ?? character.data?.personality ?? '',
        scenario: character.scenario ?? character.data?.scenario ?? '',
        first_mes: character.first_mes ?? character.data?.first_mes ?? '',
        mes_example: character.mes_example ?? character.data?.mes_example ?? '',
        creator_notes: character.data?.creator_notes ?? '',
        system_prompt: character.data?.system_prompt ?? '',
        post_history_instructions: character.data?.post_history_instructions ?? '',
        creator: character.data?.creator ?? '',
        character_version: character.data?.character_version ?? '',
        tags: character.data?.tags ?? character.tags ?? [],
        talkativeness: character.data?.extensions?.talkativeness ?? character.talkativeness ?? 0.5,
        fav: character.fav ?? character.data?.extensions?.fav ?? false,
        chat: character.chat,
        create_date: character.create_date,
    };

    return await slashCommandReturnHelper.doReturn(args.return ?? 'pipe', charData, { objectToStringFunc: x => JSON.stringify(x, null, 2) });
}

/**
 * @returns {Promise<string>} 'true' if deleted, 'false' otherwise
 */
async function deleteCharacterCallback(args) {
    let character;
    if (args.char) {
        character = findChar({ name: args.char });
        if (!character) {
            toastr.warning(t`Character "${args.char}" not found`);
            return 'false';
        }
    } else {
        if (!getCurrentCharacter()) {
            toastr.warning(t`No character selected and no char argument provided`);
            return 'false';
        }
        character = getCurrentCharacter();
    }

    const deleteChats = isTrueBoolean(args.deleteChats);
    const silent = isTrueBoolean(args.silent);

    if (!silent) {
        const confirmMessage = deleteChats
            ? t`Are you sure you want to delete "${character.name}" and all associated chats? This action cannot be undone.`
            : t`Are you sure you want to delete "${character.name}"? This action cannot be undone.`;

        const result = await callGenericPopup(confirmMessage, POPUP_TYPE.CONFIRM);
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return 'false';
        }
    }

    try {
        const success = await deleteCharacter(character.avatar, { deleteChats });
        return success ? 'true' : 'false';
    } catch (error) {
        console.error('Error deleting character:', error);
        toastr.error(t`Failed to delete character: ${error.message}`);
        return 'false';
    }
}

async function deleteMessagesByNameCallback(_, name) {
    if (!name) {
        console.warn('WARN: No name provided for /delname command');
        return;
    }

    const character = findChar({ name: name });
    name = character?.name || name;

    const messagesToDelete = [];
    chat.forEach((value) => {
        if (value.name === name) {
            messagesToDelete.push(value);
        }
    });

    if (!messagesToDelete.length) {
        console.debug('/delname: Nothing to delete');
        return;
    }

    for (const message of messagesToDelete) {
        const index = chat.indexOf(message);
        if (index !== -1) {
            console.debug(`/delname: Deleting message #${index}`, message);
            chat.splice(index, 1);
        }
    }

    await saveChatConditional();
    await reloadCurrentChat();

    toastr.info(t`Deleted ${messagesToDelete.length} messages from ${name}`);
    return '';
}

export function registerCharacterCommands() {
    const getCharacterFieldArgs = ({ requiredFields = [] } = {}) => [
        SlashCommandNamedArgument.fromProps({
            name: 'name',
            description: t`The name of the character`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('name'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'description',
            description: t`The character's description/personality definition`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('description'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'firstMessage',
            description: t`The character's first message/greeting`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('firstMessage'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'personality',
            description: t`A brief description of the personality`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('personality'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'scenario',
            description: t`The scenario or circumstances for the conversation`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('scenario'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'messageExamples',
            description: t`Example messages for the character`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('messageExamples'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'creatorNotes',
            description: t`Notes from the character creator`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('creatorNotes'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'systemPrompt',
            description: t`The character's system prompt`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('systemPrompt'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'postHistoryInstructions',
            description: t`Post-history instructions (jailbreak)`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('postHistoryInstructions'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'creator',
            description: t`The creator of the character`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('creator'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'characterVersion',
            description: t`The version of the character`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('characterVersion'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'tags',
            description: t`Comma-separated list of character card tags (embedded in the card, not ST's folder/filter tags). Use /tag-add for ST tags or /tag-import to import card tags as ST tags.`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('tags'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'favorite',
            description: t`Whether this character is a favorite`,
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            enumProvider: commonEnumProviders.boolean('trueFalse'),
            isRequired: requiredFields.includes('favorite'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'avatar',
            description: t`Avatar image. Use "prompt" to open file picker, or provide a local ST file path (e.g., characters/Name.png, backgrounds/image.png). This can also be the return value from the /imagine command. External URLs are not supported.`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('avatar'),
            enumList: [
                new SlashCommandEnumValue('prompt', 'Open file picker to select an image', 'enum', '📁'),
                new SlashCommandEnumValue('characters/...', 'Character avatars path (e.g., characters/Name.png)', 'enum', '📄', (input) => commonEnumMatchProviders.folderEnum(input, 'characters/'), () => 'characters/'),
                new SlashCommandEnumValue('backgrounds/...', 'Background image path', 'enum', '📄', (input) => commonEnumMatchProviders.folderEnum(input, 'backgrounds/'), () => 'backgrounds/'),
                new SlashCommandEnumValue('User Avatars/...', 'User avatar path', 'enum', '📄', (input) => commonEnumMatchProviders.folderEnum(input, 'User Avatars/'), () => 'User Avatars/'),
                new SlashCommandEnumValue('assets/...', 'Asset file path', 'enum', '📄', (input) => commonEnumMatchProviders.folderEnum(input, 'assets/'), () => 'assets/'),
                new SlashCommandEnumValue('user/images/...', 'User image path', 'enum', '📄', (input) => commonEnumMatchProviders.folderEnum(input, 'user/images/'), () => 'user/images/'),
            ],
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'avatarPromptResize',
            description: t`Whether to show the avatar resize/crop dialog when uploading (default: true). Ignored if "Never resize avatars" is enabled in settings.`,
            typeList: [ARGUMENT_TYPE.BOOLEAN],
            defaultValue: 'true',
            enumProvider: commonEnumProviders.boolean('trueFalse'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'talkativeness',
            description: t`How often the character speaks in group chats (0.0 to 1.0)`,
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: requiredFields.includes('talkativeness'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'world',
            description: t`The name of the lorebook to attach`,
            typeList: [ARGUMENT_TYPE.STRING],
            enumProvider: commonEnumProviders.worlds,
            isRequired: requiredFields.includes('world'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'depthPrompt',
            description: t`Character-specific depth prompt content`,
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: requiredFields.includes('depthPrompt'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'depthPromptDepth',
            description: t`Depth for the character-specific depth prompt`,
            typeList: [ARGUMENT_TYPE.NUMBER],
            isRequired: requiredFields.includes('depthPromptDepth'),
        }),
        SlashCommandNamedArgument.fromProps({
            name: 'depthPromptRole',
            description: t`Role for the depth prompt`,
            typeList: [ARGUMENT_TYPE.STRING],
            enumList: commonEnumProviders.messageRoles(),
            isRequired: requiredFields.includes('depthPromptRole'),
        }),
    ];

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'impersonate',
        callback: async function (args, prompt) {
            const options = prompt?.toString()?.trim() ? { quiet_prompt: prompt.toString().trim(), quietToLoud: true } : {};
            const shouldAwait = isTrueBoolean(args?.await?.toString());
            const outerPromise = new Promise((outerResolve) => setTimeout(async () => {
                try {
                    await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
                } catch {
                    console.warn('Timeout waiting for generation unlock');
                    toastr.warning(t`Cannot run /impersonate command while the reply is being generated.`);
                    return '';
                }

                // Prevent generate recursion
                $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

                outerResolve(new Promise(innerResolve => setTimeout(() => innerResolve(Generate('impersonate', options)), 1)));
            }, 1));

            if (shouldAwait) {
                const innerPromise = await outerPromise;
                await innerPromise;
            }

            return '';
        }
        ,
        aliases: ['imp'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await for the triggered generation before continuing`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
            <div>
                ${t`Calls an impersonation response, with an optional additional prompt.`}
            </div>
            <div>
                ${t`If <code>await=true</code> named argument is passed, the command will wait for the impersonation to end before continuing.`}
            </div>
            <div>
                <strong>${t`Example:`}</strong>
                <ul>
                    <li>
                        <pre><code class="language-stscript">/impersonate What is the meaning of life?</code></pre>
                    </li>
                </ul>
            </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-find',
        aliases: ['findchar'],
        callback: (args, name) => {
            if (typeof name !== 'string') throw new Error(t`name must be a string`);
            if (args.preferCurrent instanceof SlashCommandClosure || Array.isArray(args.preferCurrent)) throw new Error(t`preferCurrent cannot be a closure or array`);
            if (args.quiet instanceof SlashCommandClosure || Array.isArray(args.quiet)) throw new Error(t`quiet cannot be a closure or array`);

            const char = findChar({ name: name, filteredByTags: validateArrayArgString(args.tag, 'tag'), preferCurrentChar: !isFalseBoolean(args.preferCurrent), quiet: isTrueBoolean(args.quiet) });
            return char?.avatar ?? '';
        },
        returns: t`the avatar key (unique identifier) of the character`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'tag',
                description: t`Supply one or more tags to filter down to the correct character for the provided name, if multiple characters have the same name.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.tags('assigned'),
                acceptsMultiple: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'preferCurrent',
                description: t`Prefer current character or characters in a group, if multiple characters match`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: t`Do not show warning if multiple charactrers are found`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        helpString: `
        <div>
            ${t`Searches for a character and returns its avatar key.`}
        </div>
        <div>
            ${t`This can be used to choose the correct character for something like <code>/sendas</code> or other commands in need of a character name if you have multiple characters with the same name.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-find name="Chloe"</code></pre>
                    ${t`Returns the avatar key for "Chloe".`}
                </li>
                <li>
                    <pre><code>/search name="Chloe" tag="friend"</code></pre>
                    ${t`Returns the avatar key for the character "Chloe" that is tagged with "friend".`}
                    ${t`This is useful if you for example have multiple characters named "Chloe", and the others are "foe", "goddess", or anything else, so you can actually select the character you are looking for.`}
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-create',
        callback: createCharacterCallback,
        returns: t`the avatar key (unique identifier) of the created character`,
        namedArgumentList: [
            ...getCharacterFieldArgs({ requiredFields: ['name'] }),
            SlashCommandNamedArgument.fromProps({
                name: 'select',
                description: t`Whether to select/open the character after creation (default: true)`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
        ],
        helpString: `
        <div>
            ${t`Creates a new character with the specified attributes. Returns the avatar key of the created character.`}
        </div>
        <div>
            <strong>${t`Required arguments:`}</strong>
            <ul>
                <li><code>name</code> - ${t`The character's name`}</li>
            </ul>
        </div>
        <div>
            <strong>${t`Note on tags:`}</strong> ${t`The <code>tags</code> argument sets character card tags (embedded in the character file), not SillyTavern's folder/filter tags. To add ST tags after creation, use <code>/tag-add</code>. To import card tags as ST tags, use <code>/tag-import</code>.`}
        </div>
        <div>
            <strong>${t`Note on avatar:`}</strong> ${t`The <code>avatar</code> argument accepts <code>prompt</code> to open a file picker, or a local ST file path. Supported paths include: <code>characters/Name.png</code>, <code>backgrounds/image.png</code>, <code>User Avatars/avatar.png</code>, <code>assets/category/file.png</code>. This can also be the return value from the /imagine command. External URLs are not supported.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-create name="Alice" description="A friendly AI assistant" firstMessage="Hello! How can I help you today?"</code></pre>
                </li>
                <li>
                    <pre><code>/char-create name="Bob" description="A wise wizard" firstMessage="Greetings, traveler." personality="Wise, patient" scenario="A magical library" favorite=true</code></pre>
                </li>
                <li>
                    <pre><code>/char-create name="Clone" description="A clone" firstMessage="Hi!" avatar=prompt</code></pre>
                    <span>${t`(opens file picker for avatar)`}</span>
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-update',
        callback: updateCharacterCallback,
        returns: t`the avatar key of the updated character`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'char',
                description: t`Character name or avatar key. If not provided, uses the currently selected character.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
            ...getCharacterFieldArgs(),
        ],
        helpString: `
        <div>
            ${t`Updates an existing character's attributes. The character does not need to be currently selected.`}
        </div>
        <div>
            ${t`If no <code>char</code> argument is provided, updates the currently selected character.`}
        </div>
        <div>
            <strong>${t`Note on tags:`}</strong> ${t`The <code>tags</code> argument sets character card tags (embedded in the PNG), not SillyTavern's folder/filter tags. To add ST tags, use <code>/tag-add</code>. To import card tags as ST tags, use <code>/tag-import</code>.`}
        </div>
        <div>
            <strong>${t`Note on avatar:`}</strong> ${t`The <code>avatar</code> argument accepts <code>prompt</code> to open a file picker, or a local ST file path. Supported paths: <code>characters/Name.png</code>, <code>backgrounds/image.png</code>, <code>User Avatars/avatar.png</code>, <code>assets/category/file.png</code>. This can also be the return value from the /imagine command. External URLs are not supported.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-update description="An updated description for this character"</code></pre>
                    ${t`Updates the currently selected character's description.`}
                </li>
                <li>
                    <pre><code>/char-update char="Alice" personality="Cheerful and energetic" favorite=true</code></pre>
                    ${t`Updates Alice's personality and marks her as a favorite.`}
                </li>
                <li>
                    <pre><code>/imagine you | /char-update avatar="{{pipe}}"</code></pre>
                    ${t`Generates an image and sets it as the current character's avatar.`}
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-duplicate',
        aliases: ['dupe'],
        callback: duplicateCharacterCallback,
        returns: t`the avatar key (unique identifier) of the duplicated character`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'char',
                description: t`Character name or avatar key to duplicate. If not provided, uses the currently selected character.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'select',
                description: t`Whether to select/open the duplicated character after creation (default: false)`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
        ],
        helpString: `
        <div>
            ${t`Duplicates a character. Returns the avatar key of the duplicated character.`}
        </div>
        <div>
            ${t`Use <code>/char-update</code> afterwards to modify the duplicated character's fields.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-duplicate</code></pre>
                    ${t`Duplicates the currently selected character.`}
                </li>
                <li>
                    <pre><code>/char-duplicate char="Alice" select=true</code></pre>
                    ${t`Duplicates Alice and selects the new character.`}
                </li>
                <li>
                    <pre><code>/char-duplicate | /setvar key=newChar | /char-update char="{{getvar::newChar}}" name="Clone"</code></pre>
                    ${t`Duplicates the current character and renames the clone.`}
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-get',
        aliases: ['char-data'],
        callback: getCharacterDataCallback,
        returns: t`character data as JSON or a specific field value`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'char',
                description: t`Character name or avatar key. If not provided, uses the currently selected character.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'field',
                description: t`Specific field to retrieve. If not provided, returns the entire character data.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: [
                    new SlashCommandEnumValue('name', t`Character name`, enumTypes.enum),
                    new SlashCommandEnumValue('description', t`Character description`, enumTypes.enum),
                    new SlashCommandEnumValue('personality', t`Character personality`, enumTypes.enum),
                    new SlashCommandEnumValue('scenario', t`Character scenario`, enumTypes.enum),
                    new SlashCommandEnumValue('first_mes', t`First message`, enumTypes.enum),
                    new SlashCommandEnumValue('mes_example', t`Message examples`, enumTypes.enum),
                    new SlashCommandEnumValue('creator_notes', t`Creator notes`, enumTypes.enum),
                    new SlashCommandEnumValue('system_prompt', t`System prompt`, enumTypes.enum),
                    new SlashCommandEnumValue('post_history_instructions', t`Post-history instructions`, enumTypes.enum),
                    new SlashCommandEnumValue('creator', t`Creator name`, enumTypes.enum),
                    new SlashCommandEnumValue('character_version', t`Character version`, enumTypes.enum),
                    new SlashCommandEnumValue('tags', t`Character tags`, enumTypes.enum),
                    new SlashCommandEnumValue('talkativeness', t`Talkativeness`, enumTypes.enum),
                    new SlashCommandEnumValue('avatar', t`Avatar filename`, enumTypes.enum),
                    new SlashCommandEnumValue('fav', t`Favorite status`, enumTypes.enum),
                ],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way to return the result`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'pipe',
                enumList: slashCommandReturnHelper.enumList({ allowPipe: true, allowObject: true, allowChat: false, allowPopup: true, allowTextVersion: false }),
            }),
        ],
        helpString: `
        <div>
            ${t`Retrieves character data. Can get all data or a specific field.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-get field=description | /echo</code></pre>
                    ${t`Outputs the current character's description.`}
                </li>
                <li>
                    <pre><code>/char-get char="Alice" field=personality</code></pre>
                    ${t`Returns Alice's personality field.`}
                </li>
                <li>
                    <pre><code>/char-get char="Bob" return=object</code></pre>
                    ${t`Returns Bob's entire character data as an object.`}
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'char-delete',
        callback: deleteCharacterCallback,
        returns: t`true if the character was deleted, false otherwise`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'char',
                description: t`Character name or avatar key. If not provided, uses the currently selected character.`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'deleteChats',
                description: t`Whether to also delete all chats with this character`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'silent',
                description: t`Skip the confirmation popup`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
        ],
        helpString: `
        <div>
            ${t`Deletes a character from the system.`}
        </div>
        <div>
            ${t`If no <code>char</code> argument is provided, deletes the currently selected character.`}
        </div>
        <div>
            <strong>${t`Warning:`}</strong> ${t`This action is irreversible!`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/char-delete</code></pre>
                    ${t`Deletes the currently selected character (will show confirmation popup).`}
                </li>
                <li>
                    <pre><code>/char-delete char="Bob" deleteChats=true silent=true</code></pre>
                    ${t`Deletes Bob and all associated chats without confirmation.`}
                </li>
            </ul>
        </div>
        `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rename-char',
        /** @param {{silent: string, chats: string}} options @param {string} name */
        callback: async ({ silent = 'true', chats = null }, name) => {
            const renamed = await renameCharacter(name, { silent: isTrueBoolean(silent), renameChats: chats !== null ? isTrueBoolean(chats) : null });
            return String(renamed);
        },
        returns: t`true/false - Whether the rename was successful`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'silent', t`Hide any blocking popups. (if false, the name is optional. If not supplied, a popup asking for it will appear)`, [ARGUMENT_TYPE.BOOLEAN], false, false, 'true',
            ),
            new SlashCommandNamedArgument(
                'chats', t`Rename char in all previous chats`, [ARGUMENT_TYPE.BOOLEAN], false, false, '<null>',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`new char name`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Renames the current character.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'delname',
        callback: deleteMessagesByNameCallback,
        namedArgumentList: [],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.characters('character'),
            }),
        ],
        aliases: ['cancel'],
        helpString: `
        <div>
            ${t`Deletes all messages attributed to a specified name.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/delname John</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));
}
