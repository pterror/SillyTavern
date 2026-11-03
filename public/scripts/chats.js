import { css, DOMPurify } from '../lib.js';
import {
    addCopyToCodeBlocks,
    appendMediaToMessage,
    getCurrentChatId,
    getCurrentCharacter,
    getSelectionState,
    name2,
    reloadCurrentChat,
    saveSettingsDebounced,
    chatOpEdit,
    chatOpEditMany,
    updateMessage,
    neutralCharacterName,
    updateChatMetadata,
    system_message_types,
    substituteParams,
    openChatMacroScope,
    getSystemMessageByType,
    printMessages,
    clearChat,
    refreshSwipeButtons,
    getMediaIndex,
    getMediaDisplay,
    chatElement,
    updateIn,
    macroPerson,
} from '../script.js';
import { renderMarkdown } from './marked-processor.js';
import { withFilledAbout, withMacroPlaceholders, withMacroValues } from './safe-macros.js';
import { fetchMacroValues, macroValuesOf } from './macro-values.js';
import { insertMacroPills } from './macro-pill.js';
import { initImageLightbox, onLightboxImageClick } from './image-lightbox.js';
import { openEditorLayer } from './editor-layer.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { eventSource, event_types } from './events.js';
import { selected_group } from './group-chats.js';
import { power_user } from './power-user.js';
import {
    extractTextFromHTML,
    extractTextFromMarkdown,
    extractTextFromPDF,
    extractTextFromEpub,
    getBase64Async,
    getStringHash,
    humanFileSize,
    saveBase64AsFile,
    extractTextFromOffice,
    download,
    getFileText,
    getFileExtension,
    convertTextToBase64,
    isSameFile,
    clamp,
} from './utils.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { DragAndDropHandler } from './dragdrop.js';
import { renderTemplateAsync } from './templates.js';
import { t } from './i18n.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import { accountStorage } from './util/AccountStorage.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR, SWIPE_DIRECTION } from './constants.js';

/**
 * @typedef {Object} FileAttachment
 * @property {string} url File URL
 * @property {number} size File size
 * @property {string} name File name
 * @property {number} created Timestamp
 * @property {string} [text] File text
 */

/**
 * @typedef {function} ConverterFunction
 * @param {File} file File object
 * @returns {Promise<string>} Converted file text
 */

const fileSizeLimit = 1024 * 1024 * 350; // 350 MB

/** @type {Record<string, ConverterFunction>} */
const converters = {
    'application/pdf': extractTextFromPDF,
    'text/html': extractTextFromHTML,
    'text/markdown': extractTextFromMarkdown,
    'application/epub+zip': extractTextFromEpub,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractTextFromOffice,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractTextFromOffice,
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractTextFromOffice,
    'application/vnd.oasis.opendocument.text': extractTextFromOffice,
    'application/vnd.oasis.opendocument.presentation': extractTextFromOffice,
    'application/vnd.oasis.opendocument.spreadsheet': extractTextFromOffice,
};

function findConverterKey(type) {
    return Object.keys(converters).find((key) => {
        if (type === key) {
            return true;
        }

        if (key.endsWith('*')) {
            return type.startsWith(key.substring(0, key.length - 1));
        }

        return false;
    });
}

function isConvertible(type) {
    return Boolean(findConverterKey(type));
}

function getConverter(type) {
    const key = findConverterKey(type);
    return key && converters[key];
}

export async function hideChatMessageRange(start, end, unhide, nameFitler = null) {
    if (isNaN(start)) return;
    if (!end) end = start;
    const hide = !unhide;
    const changed = [];

    for (let messageId = start; messageId <= end; messageId++) {
        const message = chat[messageId];
        if (!message) continue;
        if (nameFitler && message.name !== nameFitler) continue;

        updateMessage(messageId, { is_system: hide });
        changed.push(messageId);

        const messageBlock = $(`.mes[mesid="${messageId}"]`);
        if (!messageBlock.length) continue;
        messageBlock.attr('is_system', String(hide));
    }

    refreshSwipeButtons();

    await chatOpEditMany(changed).catch(error =>
        console.error('Could not save the hidden state for those messages:', error));
}

export async function populateFileAttachment(message, inputId = 'file_form_input') {
    try {
        if (!message) return;
        const extra = { ...(message.extra ?? {}) };
        const fileInput = document.getElementById(inputId);
        if (!(fileInput instanceof HTMLInputElement)) return;

        for (const file of fileInput.files) {
            const slug = getStringHash(file.name);
            const fileNamePrefix = `${Date.now()}_${slug}`;
            const fileBase64 = await getBase64Async(file);
            let base64Data = fileBase64.split(',')[1];
            const extension = getFileExtension(file);

            const mediaType = MEDIA_TYPE.getFromMime(file.type);
            if (mediaType) {
                const imageUrl = await saveBase64AsFile(base64Data, name2, fileNamePrefix, extension);
                extra.media = Array.isArray(extra.media) ? [...extra.media] : [];
                /** @type {MediaAttachment} */
                const mediaAttachment = {
                    url: imageUrl,
                    type: mediaType,
                    title: file.name,
                    source: MEDIA_SOURCE.UPLOAD,
                };
                extra.media.push(mediaAttachment);
                extra.media_index = extra.media.length - 1;
                extra.inline_image = true;
            } else {
                const uniqueFileName = `${fileNamePrefix}.txt`;

                if (isConvertible(file.type)) {
                    try {
                        const converter = getConverter(file.type);
                        const fileText = await converter(file);
                        base64Data = convertTextToBase64(fileText);
                    } catch (error) {
                        toastr.error(String(error), t`Could not convert file`);
                        console.error('Could not convert file', error);
                    }
                }

                const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);

                if (!fileUrl) {
                    continue;
                }

                extra.files = Array.isArray(extra.files) ? [...extra.files] : [];

                extra.files.push({
                    url: fileUrl,
                    size: file.size,
                    name: file.name,
                    created: Date.now(),
                });
            }
        }

        const mesId = chat.indexOf(message);
        if (mesId >= 0) {
            updateIn(mesId, ['extra'], extra);
        } else {
            message.extra = extra;
        }
    } catch (error) {
        console.error('Could not upload file', error);
        toastr.error(t`Either the file is corrupted or its format is not supported.`, t`Could not upload the file`);
    } finally {
        $('#file_form').trigger('reset');
    }
}

async function uploadFileAttachment(fileName, base64Data) {
    try {
        const result = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: fileName,
                data: base64Data,
            }),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const responseData = await result.json();
        return responseData.path;
    } catch (error) {
        toastr.error(String(error), t`Could not upload file`);
        console.error('Could not upload file', error);
    }
}

async function getFileAttachment(url) {
    try {
        const result = await fetch(url, {
            method: 'GET',
            cache: 'force-cache',
            headers: getRequestHeaders(),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const text = await result.text();
        return text;
    } catch (error) {
        toastr.error(error, t`Could not download file`);
        console.error('Could not download file', error);
    }
}

async function validateFile(file) {
    const fileText = await file.text();
    const isMedia = file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/');
    const isBinary = /^[\x00-\x08\x0E-\x1F\x7F-\xFF]*$/.test(fileText);

    if (!isMedia && file.size > fileSizeLimit) {
        toastr.error(t`File is too big. Maximum size is ${humanFileSize(fileSizeLimit)}.`);
        return false;
    }

    if (isBinary && !isMedia && !isConvertible(file.type)) {
        toastr.error(t`Binary files are not supported. Select a text file or image.`);
        return false;
    }

    return true;
}

export function hasPendingFileAttachment() {
    const fileInput = document.getElementById('file_form_input');
    if (!(fileInput instanceof HTMLInputElement)) return false;
    return fileInput.files.length > 0;
}

async function onFileAttach(fileList) {
    if (!fileList || fileList.length === 0) return;

    for (const file of fileList) {
        const isValid = await validateFile(file);

        if (!isValid) {
            toastr.warning(t`File ${file.name} is not supported.`);
            $('#file_form').trigger('reset');
            return;
        }
    }

    const name = fileList.length === 1 ? fileList[0].name : t`${fileList.length} files selected`;
    const size = [...fileList].reduce((acc, file) => acc + file.size, 0);
    const title = [...fileList].map(x => x.name).join('\n');
    $('#file_form .file_name').text(name).attr('title', title);
    $('#file_form .file_size').text(humanFileSize(size)).attr('title', size);
    $('#file_form').removeClass('displayNone');

    // Reset form on chat change (if not on a welcome screen)
    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        eventSource.once(event_types.CHAT_CHANGED, () => {
            $('#file_form').trigger('reset');
        });
    }
}

/**
 * @param {JQuery<HTMLElement>} messageBlock Message block element
 * @param {number} messageId Message ID
 * @param {number} fileIndex File index
 */
async function deleteMessageFile(messageBlock, messageId, fileIndex) {
    if (isNaN(messageId) || isNaN(fileIndex)) {
        console.warn('Invalid message ID or file index');
        return;
    }

    const confirm = await callGenericPopup('Are you sure you want to delete this file?', POPUP_TYPE.CONFIRM);

    if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const message = chat[messageId];

    if (!Array.isArray(message?.extra?.files)) {
        console.debug('Message has no files');
        return;
    }

    if (fileIndex < 0 || fileIndex >= message.extra.files.length) {
        console.warn('Invalid file index for message');
        return;
    }

    const url = message.extra.files[fileIndex]?.url;
    const updated = updateIn(messageId, ['extra', 'files'], (list) => list.filter((_, i) => i !== fileIndex));

    await chatOpEdit(messageId).catch(error =>
        console.error('Could not save the file removal for that message:', error));
    await deleteFileFromServer(url);

    appendMediaToMessage(updated, messageBlock, SCROLL_BEHAVIOR.KEEP);
}

/**
 * @param {number} messageId Message ID
 * @param {number} fileIndex File index
 */
async function viewMessageFile(messageId, fileIndex) {
    if (isNaN(messageId) || isNaN(fileIndex)) {
        console.warn('Invalid message ID or file index');
        return;
    }

    const message = chat[messageId];

    if (!Array.isArray(message?.extra?.files)) {
        console.debug('Message has no files');
        return;
    }

    if (fileIndex < 0 || fileIndex >= message.extra.files.length) {
        console.warn('Invalid file index for message');
        return;
    }

    const messageFile = message.extra.files[fileIndex];

    if (!messageFile) {
        console.debug('Message has no file or it is empty');
        return;
    }

    await openFilePopup(messageFile);
}

/**
 * @param {number} messageId
 * @param {JQuery<HTMLElement>} messageBlock
 * @returns {Promise<void>}
 */
function embedMessageFile(messageId, messageBlock) {
    const message = chat[messageId];

    if (!message) {
        console.warn('Failed to find message with id', messageId);
        return;
    }

    $('#embed_file_input')
        .off('change')
        .on('change', parseAndUploadEmbed)
        .trigger('click');

    async function parseAndUploadEmbed(/** @type {JQuery.ChangeEvent} */ e) {
        if (!(e.target instanceof HTMLInputElement)) return;
        if (!e.target.files.length) return;

        for (const file of e.target.files) {
            const isValid = await validateFile(file);

            if (!isValid) {
                toastr.warning(t`File ${file.name} is not supported.`);
                $('#file_form').trigger('reset');
                return;
            }
        }

        await populateFileAttachment(message, 'embed_file_input');
        appendMediaToMessage(message, messageBlock, SCROLL_BEHAVIOR.KEEP);
        await chatOpEdit(messageId).catch(error =>
            console.error('Could not save the embedded file for that message:', error));
    }
}

/**
 * @param {ChatMessage} message Message object
 * @param {string} messageText Message text
 * @returns {Promise<string>} Message text with file content appended.
 */
export async function appendFileContent(message, messageText) {
    if (!message || !message.extra || typeof message.extra !== 'object') {
        return messageText;
    }
    const extra = { ...message.extra };
    const commit = () => {
        const mesId = chat.indexOf(message);
        if (mesId >= 0) {
            updateIn(mesId, ['extra'], extra);
        } else {
            message.extra = extra;
        }
    };

    if (extra.fileLength >= 0) {
        delete extra.fileLength;
    }
    if (Array.isArray(extra.files) && extra.files.length > 0) {
        const fileTexts = [];
        for (const file of extra.files) {
            const fileText = file.text || (await getFileAttachment(file.url));
            if (fileText) {
                fileTexts.push(fileText);
            }
        }
        const mergedFileTexts = fileTexts.join('\n\n') + '\n\n';
        extra.fileLength = mergedFileTexts.length;
        commit();
        return mergedFileTexts + messageText;
    }
    commit();
    return messageText;
}

/**
 * @param {string} text
 * @returns {string} Encoded message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function encodeStyleTags(text) {
    const styleRegex = /<style>(.+?)<\/style>/gims;
    return text.replaceAll(styleRegex, (_, match) => {
        return `<custom-style>${encodeURIComponent(match)}</custom-style>`;
    });
}

/**
 * @param {string} text Message text
 * @param {object} options Options object
 * @param {string} options.prefix Prefix the selectors with this value
 * @returns {string} Sanitized message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function decodeStyleTags(text, { prefix } = { prefix: '.mes_text ' }) {
    const styleDecodeRegex = /<custom-style>(.+?)<\/custom-style>/gms;
    const mediaAllowed = isExternalMediaAllowed();

    function sanitizeRule(rule) {
        if (Array.isArray(rule.selectors)) {
            for (let i = 0; i < rule.selectors.length; i++) {
                const selector = rule.selectors[i];
                if (selector) {
                    rule.selectors[i] = prefix + sanitizeSelector(selector);
                }
            }
        }
        if (!mediaAllowed && Array.isArray(rule.declarations) && rule.declarations.length > 0) {
            rule.declarations = rule.declarations.filter(declaration => !declaration.value.includes('://'));
        }
    }

    function sanitizeSelector(selector) {
        // Handle pseudo-classes that can contain nested selectors
        const pseudoClasses = ['has', 'not', 'where', 'is', 'matches', 'any'];
        const pseudoRegex = new RegExp(`:(${pseudoClasses.join('|')})\\(([^)]+)\\)`, 'g');

        // First, sanitize any nested selectors within pseudo-classes
        selector = selector.replace(pseudoRegex, (match, pseudoClass, content) => {
            // Recursively sanitize the content within the pseudo-class
            const sanitizedContent = sanitizeSimpleSelector(content);
            return `:${pseudoClass}(${sanitizedContent})`;
        });

        // Then sanitize the main selector parts
        return sanitizeSimpleSelector(selector);
    }

    function sanitizeSimpleSelector(selector) {
        // Split by spaces but preserve complex selectors
        return selector.split(/\s+/).map((part) => {
            // Handle class selectors, but preserve pseudo-classes and other complex parts
            return part.replace(/\.([\w-]+)/g, (match, className) => {
                // Don't modify if it's already prefixed with 'custom-'
                if (className.startsWith('custom-')) {
                    return match;
                }
                return `.custom-${className}`;
            });
        }).join(' ');
    }

    function sanitizeRuleSet(ruleSet) {
        if (Array.isArray(ruleSet.selectors) || Array.isArray(ruleSet.declarations)) {
            sanitizeRule(ruleSet);
        }

        if (Array.isArray(ruleSet.rules)) {
            ruleSet.rules = ruleSet.rules.filter(rule => rule.type !== 'import');

            for (const mediaRule of ruleSet.rules) {
                sanitizeRuleSet(mediaRule);
            }
        }
    }

    return text.replaceAll(styleDecodeRegex, (_, style) => {
        try {
            let styleCleaned = decodeURIComponent(style).replaceAll(/<br\/>/g, '');
            const ast = css.parse(styleCleaned);
            const sheet = ast?.stylesheet;
            if (sheet) {
                sanitizeRuleSet(ast.stylesheet);
            }
            return `<style>${css.stringify(ast)}</style>`;
        } catch (error) {
            return `CSS ERROR: ${error}`;
        }
    });
}

class StylesPreference {
    /**
     * @param {string|null} avatarId - The avatar ID of the character
     */
    constructor(avatarId) {
        this.avatarId = avatarId;
    }

    /**
     * @returns {boolean} True if preference exists, false otherwise
     */
    exists() {
        if (!this.avatarId) return true;
        const character = charactersStore.get(this.avatarId);
        return character?.allow_global_styles != null;
    }

    /**
     * @returns {boolean} True if global styles are allowed, false otherwise
     */
    get() {
        if (!this.avatarId) return false;
        const character = charactersStore.get(this.avatarId);
        return !!character?.allow_global_styles;
    }

    /**
     * @param {boolean} allowed - Whether global styles are allowed
     */
    set(allowed) {
        if (!this.avatarId) return;
        const character = charactersStore.get(this.avatarId);
        if (character) {
            character.allow_global_styles = allowed;
        }
        fetch('/api/characters/allow-global-styles', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar: this.avatarId, allowed }),
        }).catch(err => console.error('Failed to save global styles preference:', err));
    }
}

async function migrateAllowGlobalStylesToDb() {
    if (localStorage.getItem('AllowGlobalStyles_migrated_to_db') === '1') return;

    const bulk = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('AllowGlobalStyles-')) {
            const avatar = key.substring('AllowGlobalStyles-'.length);
            const allowed = localStorage.getItem(key) === 'true';
            if (avatar) bulk.push({ avatar, allowed });
        }
    }

    if (bulk.length > 0) {
        try {
            await fetch('/api/characters/allow-global-styles', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ bulk }),
            });
        } catch (err) {
            console.error('AllowGlobalStyles migration failed:', err);
            return;
        }
    }

    localStorage.setItem('AllowGlobalStyles_migrated_to_db', '1');
}

/**
 * @param {string} text Raw Markdown text
 * @param {string} avatarId Avatar ID
 * @param {object} [options]
 * @param {import('./safe-macros.js').MacroValueOf} [options.valueOf] The macros' values (macro-values.js), each macro
 * shown as a pill holding its value; for the app's previews. Left out (an extension's call), every macro is filled in
 * here, as upstream does.
 * @param {string} [options.styleScope='#creator_notes_preview'] Selector of the element the HTML is shown in: unless
 * the character's styles are allowed everywhere, its `<style>` rules apply only inside it.
 * @returns {string} Formatted HTML text
 */
export function formatCreatorNotes(text, avatarId, { valueOf, styleScope = '#creator_notes_preview' } = {}) {
    const preference = new StylesPreference(avatarId);
    const sanitizeStyles = !preference.get();
    const decodeStyleParam = { prefix: sanitizeStyles ? `${styleScope} ` : '' };
    /** @type {DOMPurify.Config} */
    const config = {
        RETURN_DOM: false,
        RETURN_DOM_FRAGMENT: false,
        RETURN_TRUSTED_TYPE: false,
        MESSAGE_SANITIZE: true,
        ADD_TAGS: ['custom-style'],
    };

    const { text: placeheld, macros } = valueOf ? withMacroPlaceholders(text, valueOf) : { text: substituteParams(text), macros: [] };
    let html = renderMarkdown(placeheld);
    html = encodeStyleTags(html);
    html = DOMPurify.sanitize(html, config);
    html = decodeStyleTags(html, decodeStyleParam);

    return insertMacroPills(html, macros, t, macroName => withFilledAbout(macroPerson(macroName, { avatar: avatarId }), macroName, valueOf ?? (() => undefined)));
}

async function openGlobalStylesPreferenceDialog() {
    if (selected_group) {
        toastr.info(t`To change the global styles preference, please select a character individually.`);
        return;
    }

    const entityId = getCurrentEntityId();
    const preference = new StylesPreference(entityId);
    const currentValue = preference.get();

    const template = $(await renderTemplateAsync('globalStylesPreference'));

    const allowedRadio = template.find('#global_styles_allowed');
    const forbiddenRadio = template.find('#global_styles_forbidden');

    allowedRadio.on('change', () => {
        preference.set(true);
        allowedRadio.prop('checked', true);
        forbiddenRadio.prop('checked', false);
    });

    forbiddenRadio.on('change', () => {
        preference.set(false);
        allowedRadio.prop('checked', false);
        forbiddenRadio.prop('checked', true);
    });

    const currentPreferenceRadio = currentValue ? allowedRadio : forbiddenRadio;
    template.find(currentPreferenceRadio).prop('checked', true);

    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: false, large: false });

    const newValue = preference.get();
    if (newValue !== currentValue) {
        $('#rm_button_selected_ch').trigger('click');
        setGlobalStylesButtonClass(newValue);
    }
}

async function checkForCreatorNotesStyles() {
    if (getSelectionState().type !== 'character') {
        return;
    }

    const notes = getCurrentCharacter().data?.creator_notes || getCurrentCharacter().creatorcomment;
    const avatarId = getCurrentCharacter().avatar;
    const styleContents = await getStyleContentsFromMarkdown(notes);
    if (getCurrentCharacter()?.avatar !== avatarId) {
        return;
    }

    if (!styleContents) {
        setGlobalStylesButtonClass(null);
        return;
    }

    const preference = new StylesPreference(avatarId);
    const hasPreference = preference.exists();
    if (!hasPreference) {
        if (power_user.always_allow_custom_css) {
            preference.set(true);
        } else {
            const template = $(await renderTemplateAsync('globalStylesPopup'));
            template.find('textarea').val(styleContents);
            const confirmResult = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
                wide: false,
                large: false,
                okButton: t`Just to Creator's Notes`,
                cancelButton: t`Apply to the entire app`,
            });

            switch (confirmResult) {
                case POPUP_RESULT.AFFIRMATIVE:
                    preference.set(false);
                    break;
                case POPUP_RESULT.NEGATIVE:
                    preference.set(true);
                    break;
                case POPUP_RESULT.CANCELLED:
                    preference.set(false);
                    break;
            }
        }

        $('#rm_button_selected_ch').trigger('click');
    }

    const currentPreference = preference.get();
    setGlobalStylesButtonClass(currentPreference);
}

/**
 * @param {boolean|null} state State of the button
 */
function setGlobalStylesButtonClass(state) {
    const button = $('#creators_note_styles_button');
    button.toggleClass('empty', state === null);
    button.toggleClass('allowed', state === true);
    button.toggleClass('forbidden', state === false);
}

/**
 * @param {string} text Markdown text
 * @returns {Promise<string>} The joined contents of all style elements
 */
async function getStyleContentsFromMarkdown(text) {
    if (!text) {
        return '';
    }

    const values = await macroValuesOf(text, openChatMacroScope());
    const html = renderMarkdown(withMacroValues(text, values.valueOf));
    const parsedDocument = new DOMParser().parseFromString(html, 'text/html');
    const styleElements = Array.from(parsedDocument.querySelectorAll('style'));
    return styleElements
        .filter(s => s.textContent.trim().length > 0)
        .map(s => s.textContent.trim())
        .join('\n\n');
}

async function openExternalMediaOverridesDialog() {
    const entityId = getCurrentEntityId();

    if (!entityId) {
        toastr.info(t`No character or group selected`);
        return;
    }

    const template = $(await renderTemplateAsync('forbidMedia'));
    template.find('.forbid_media_global_state_forbidden').toggle(power_user.forbid_external_media);
    template.find('.forbid_media_global_state_allowed').toggle(!power_user.forbid_external_media);

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        template.find('#forbid_media_override_allowed').prop('checked', true);
    } else if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        template.find('#forbid_media_override_forbidden').prop('checked', true);
    } else {
        template.find('#forbid_media_override_global').prop('checked', true);
    }

    callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: false, large: false });
}

function getCurrentEntityId() {
    if (selected_group) {
        return String(selected_group);
    }

    return getCurrentCharacter()?.avatar ?? null;
}

export function isExternalMediaAllowed() {
    const entityId = getCurrentEntityId();
    if (!entityId) {
        return !power_user.forbid_external_media;
    }

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        return true;
    }

    if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        return false;
    }

    return !power_user.forbid_external_media;
}

/**
 * @param {number} messageId Message ID
 * @param {number} mediaIndex Media index
 * @returns {HTMLElement} Enlarged media element
 */
function expandMessageMedia(messageId, mediaIndex) {
    if (isNaN(messageId) || isNaN(mediaIndex)) {
        console.warn('Invalid message ID or media index');
        return;
    }

    /** @type {ChatMessage} */
    const message = chat[messageId];

    if (!Array.isArray(message?.extra?.media) || message.extra.media.length === 0) {
        console.warn('Message has no media to expand');
        return;
    }

    const mediaAttachment = message.extra.media[mediaIndex];
    const title = mediaAttachment.title || message.extra.title || '';

    if (!mediaAttachment) {
        return;
    }

    if (mediaAttachment.type === MEDIA_TYPE.AUDIO) {
        console.warn('Audio media cannot be expanded');
        return;
    }

    const isVideo = mediaAttachment.type === MEDIA_TYPE.VIDEO;
    return showMediaLightbox(mediaAttachment.url, title, isVideo);
}

/**
 * @param {string} url
 * @param {string} title
 * @param {boolean} isVideo
 * @returns {HTMLElement}
 */
export function showMediaLightbox(url, title = '', isVideo = false) {
    let mediaElement;

    if (isVideo) {
        const video = document.createElement('video');
        video.src = url;
        video.classList.add('img_enlarged');
        video.controls = true;
        video.autoplay = true;
        mediaElement = video;
    } else {
        const img = document.createElement('img');
        img.src = url;
        img.classList.add('img_enlarged');
        mediaElement = img;
    }

    const mediaHolder = document.createElement('div');
    mediaHolder.classList.add('img_enlarged_holder');
    mediaHolder.append(mediaElement);
    const mediaContainer = document.createElement('div');
    mediaContainer.classList.add('img_enlarged_container');
    mediaContainer.append(mediaHolder);

    mediaElement.addEventListener('click', event => {
        const shouldZoom = !mediaElement.classList.contains('zoomed') && mediaElement.nodeName === 'IMG';
        mediaElement.classList.toggle('zoomed', shouldZoom);
        event.stopPropagation();
    });

    if (!isVideo) {
        const MIN_SCALE = 1;
        const MAX_SCALE = 5;
        const SCALE_STEP = 0.25;
        let scale = MIN_SCALE;

        const applyScale = newScale => {
            scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
            mediaElement.style.transform = scale > MIN_SCALE ? `scale(${scale})` : '';
            mediaHolder.style.overflow = scale > MIN_SCALE ? 'auto' : '';
        };

        mediaHolder.addEventListener('wheel', event => {
            event.preventDefault();
            event.stopPropagation();
            applyScale(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
        }, { passive: false });

        const zoomControls = document.createElement('div');
        zoomControls.classList.add('img_enlarged_zoom_controls');

        const zoomIn = document.createElement('div');
        zoomIn.classList.add('right_menu_button', 'fa-solid', 'fa-magnifying-glass-plus');
        zoomIn.title = t`Zoom in`;

        const zoomOut = document.createElement('div');
        zoomOut.classList.add('right_menu_button', 'fa-solid', 'fa-magnifying-glass-minus');
        zoomOut.title = t`Zoom out`;

        const zoomReset = document.createElement('div');
        zoomReset.classList.add('right_menu_button', 'fa-solid', 'fa-magnifying-glass');
        zoomReset.title = t`Reset zoom`;

        for (const button of [zoomIn, zoomOut, zoomReset]) {
            button.addEventListener('click', event => event.stopPropagation());
        }
        zoomIn.addEventListener('click', () => applyScale(scale + SCALE_STEP));
        zoomOut.addEventListener('click', () => applyScale(scale - SCALE_STEP));
        zoomReset.addEventListener('click', () => applyScale(MIN_SCALE));

        zoomControls.append(zoomIn, zoomOut, zoomReset);
        mediaContainer.append(zoomControls);
    }

    if (title.trim().length > 0) {
        const mediaTitlePre = document.createElement('pre');
        const mediaTitleCode = document.createElement('code');
        mediaTitleCode.classList.add('img_enlarged_title', 'txt');
        mediaTitleCode.textContent = title;
        mediaTitlePre.append(mediaTitleCode);
        mediaTitleCode.addEventListener('click', event => {
            event.stopPropagation();
        });
        mediaContainer.append(mediaTitlePre);
        addCopyToCodeBlocks(mediaContainer);
    }

    const popup = new Popup(mediaContainer, POPUP_TYPE.DISPLAY, '', { large: true, transparent: true });

    popup.dlg.style.width = 'unset';
    popup.dlg.style.height = 'unset';
    popup.dlg.addEventListener('click', () => {
        popup.completeCancelled();
    });

    popup.show();
    return mediaElement;
}

/**
 * @param {number} messageId Message ID
 * @param {number} mediaIndex Image index
 * @param {JQuery<HTMLElement>} messageBlock Message block element
 */
async function deleteMessageMedia(messageId, mediaIndex, messageBlock) {
    if (isNaN(messageId) || isNaN(mediaIndex)) {
        console.warn('Invalid message ID or media index');
        return;
    }

    const deleteUrls = [];
    const deleteFromServerId = 'delete_media_files_checkbox';
    let deleteFromServer = true;

    const value = await Popup.show.confirm(t`Delete media from message?`, t`This action can't be undone.`, {
        okButton: t`Delete one`,
        cancelButton: false,
        customButtons: [
            {
                text: t`Delete all`,
                appendAtEnd: true,
                result: POPUP_RESULT.CUSTOM1,
            },
            {
                text: t`Cancel`,
                appendAtEnd: true,
                result: POPUP_RESULT.CANCELLED,
            },
        ],
        customInputs: [
            {
                type: 'checkbox',
                label: t`Also delete files from server`,
                id: deleteFromServerId,
                defaultState: true,
            },
        ],
        onClose: (popup) => {
            deleteFromServer = Boolean(popup.inputResults.get(deleteFromServerId) ?? false);
        },
    });

    if (!value) {
        return;
    }

    /** @type {ChatMessage} */
    const message = chat[messageId];

    if (!Array.isArray(message?.extra?.media)) {
        console.debug('Message has no media');
        return;
    }

    if (mediaIndex < 0 || mediaIndex >= message.extra.media.length) {
        console.warn('Invalid media index for message');
        return;
    }

    deleteUrls.push(message.extra.media[mediaIndex].url);

    const extra = { ...message.extra, media: message.extra.media.filter((_, i) => i !== mediaIndex) };

    if (extra.media_index === mediaIndex) {
        const newIndex = mediaIndex > 0 ? mediaIndex - 1 : 0;
        extra.media_index = clamp(newIndex, 0, extra.media.length - 1);
    }

    if (value === POPUP_RESULT.CUSTOM1) {
        for (const media of extra.media) {
            deleteUrls.push(media.url);
        }
        delete extra.media;
        delete extra.inline_image;
        delete extra.title;
        delete extra.append_title;
    }

    const updatedMessage = updateIn(messageId, ['extra'], extra);

    if (deleteFromServer) {
        await deleteMediaBatchFromServer(deleteUrls.filter(Boolean), true);
    }

    await chatOpEdit(messageId).catch(error =>
        console.error('Could not save the media removal for that message:', error));
    appendMediaToMessage(updatedMessage, messageBlock, SCROLL_BEHAVIOR.KEEP);
}

/**
 * @param {number} messageId Message ID
 * @param {JQuery<HTMLElement>} messageBlock Message block element
 * @param {MEDIA_DISPLAY} targetDisplay Target display mode
 */
async function switchMessageMediaDisplay(messageId, messageBlock, targetDisplay) {
    if (isNaN(messageId)) {
        console.warn('Invalid message ID');
        return;
    }

    /** @type {ChatMessage} */
    let message = chat[messageId];

    if (!message) {
        console.warn('Message not found for ID', messageId);
        return;
    }

    const existingExtra = (message.extra && typeof message.extra === 'object') ? message.extra : {};
    updateMessage(messageId, { extra: { ...existingExtra, media_display: targetDisplay } });
    message = chat[messageId];

    await chatOpEdit(messageId).catch(error =>
        console.error('Could not save the media display mode for that message:', error));
    appendMediaToMessage(message, messageBlock, SCROLL_BEHAVIOR.KEEP);
}

/**
 * Deletes multiple media files from the server in a single batch request.
 * @param {string[]} urls Paths to the media files on the server
 * @param {boolean} [silent=false] If true, do not show error messages
 * @returns {Promise<boolean>} True if all media files were deleted, false otherwise.
 */
async function deleteMediaBatchFromServer(urls, silent = false) {
    if (urls.length === 0) return true;

    try {
        const result = await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ paths: urls }),
        });

        if (!result.ok) {
            if (!silent) {
                const error = await result.text();
                throw new Error(error);
            }
            return false;
        }

        const data = await result.json();
        return (data.results ?? []).every(entry => entry.ok);
    } catch (error) {
        toastr.error(String(error), t`Could not delete image`);
        console.error('Could not delete image', error);
        return false;
    }
}

/**
 * @param {string} url Path to the file on the server
 * @param {boolean} [silent=false] If true, do not show error messages
 * @returns {Promise<boolean>} True if file was deleted, false otherwise.
 */
async function deleteFileFromServer(url, silent = false) {
    try {
        const result = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });

        if (!result.ok) {
            if (!silent) {
                const error = await result.text();
                throw new Error(error);
            }
            return false;
        }

        return true;
    } catch (error) {
        toastr.error(String(error), t`Could not delete file`);
        console.error('Could not delete file', error);
        return false;
    }
}

/**
 * @param {FileAttachment} attachment File attachment
 */
async function openFilePopup(attachment) {
    const fileText = attachment.text || (await getFileAttachment(attachment.url));

    const modalTemplate = $('<div><pre><code></code></pre></div>');
    modalTemplate.find('code').addClass('txt').text(fileText);
    modalTemplate.addClass('file_modal').addClass('textarea_compact').addClass('fontsize90p');
    addCopyToCodeBlocks(modalTemplate);

    callGenericPopup(modalTemplate, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

const NEUTRAL_CHAT_KEY = 'neutralChat';

export function preserveNeutralChat() {
    if (getSelectionState().type !== 'none' || name2 !== neutralCharacterName) {
        return;
    }

    sessionStorage.setItem(NEUTRAL_CHAT_KEY, JSON.stringify({ chat, chat_metadata }));
}

export function restoreNeutralChat() {
    if (getSelectionState().type !== 'none' || name2 !== neutralCharacterName) {
        return;
    }

    const neutralChat = sessionStorage.getItem(NEUTRAL_CHAT_KEY);
    if (!neutralChat) {
        return;
    }

    const { chat: neutralChatData, chat_metadata: neutralChatMetadata } = JSON.parse(neutralChat);
    chat.splice(0, chat.length, ...neutralChatData);
    updateChatMetadata(neutralChatMetadata, true);
    sessionStorage.removeItem(NEUTRAL_CHAT_KEY);
}


export function initMessageMediaVolume() {
    const startAtUserVolume = (/** @type {Event} */ event) => {
        const media = event.target;
        if (!(media instanceof HTMLMediaElement) || media.dataset.userVolume !== undefined) return;
        if (!media.closest('.mes_text, .mes_reasoning, .mes_media_wrapper, .field_preview, .cm-editor, .image_lightbox')) return;
        media.dataset.userVolume = '';
        media.volume = Math.max(0, Math.min(100, Number(power_user.media_volume) || 0)) / 100;
    };
    for (const type of ['loadstart', 'loadedmetadata', 'play']) document.addEventListener(type, startAtUserVolume, true);
}

export function addDOMPurifyHooks() {
    DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if ('target' in node) {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener');
        }
    });

    DOMPurify.addHook('uponSanitizeAttribute', (node, data, config) => {
        if (!config.MESSAGE_SANITIZE) {
            return;
        }

        /* Retain the classes on UI elements of messages that interact with the main UI */
        const permittedNodeTypes = ['BUTTON', 'DIV'];
        if (config.MESSAGE_ALLOW_SYSTEM_UI && node.classList.contains('menu_button') && permittedNodeTypes.includes(node.nodeName)) {
            return;
        }

        switch (data.attrName) {
            case 'class': {
                if (data.attrValue) {
                    data.attrValue = data.attrValue.split(' ').map((v) => {
                        if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') {
                            return v;
                        }

                        return 'custom-' + v;
                    }).join(' ');
                }
                break;
            }
        }
    });

    DOMPurify.addHook('uponSanitizeElement', (node, _, config) => {
        if (!config.MESSAGE_SANITIZE) {
            return;
        }

        if (node instanceof HTMLMediaElement && !power_user.media_autoplay) {
            node.removeAttribute('autoplay');
        }

        if (node instanceof HTMLUnknownElement) {
            node.innerHTML = node.innerHTML.trim();

            /** @type {Text[]} */
            const candidates = [];
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const textNode = /** @type {Text} */ (walker.currentNode);
                if (!textNode.data.includes('\n')) continue;

                if (textNode.parentElement && textNode.parentElement.closest('pre')) continue;

                candidates.push(textNode);
            }

            for (const textNode of candidates) {
                const parts = textNode.data.split('\n');
                const frag = document.createDocumentFragment();
                parts.forEach((part, idx) => {
                    if (part.length) {
                        frag.appendChild(document.createTextNode(part));
                    }
                    if (idx < parts.length - 1) {
                        frag.appendChild(document.createElement('br'));
                    }
                });
                textNode.replaceWith(frag);
            }
        }

        const isMediaAllowed = isExternalMediaAllowed();
        if (isMediaAllowed) {
            return;
        }

        if (!(node instanceof Element)) {
            return;
        }

        let mediaBlocked = false;

        switch (node.tagName) {
            case 'AUDIO':
            case 'VIDEO':
            case 'SOURCE':
            case 'TRACK':
            case 'EMBED':
            case 'OBJECT':
            case 'IMG': {
                const isExternalUrl = (url) => (url.indexOf('://') > 0 || url.indexOf('//') === 0) && !url.startsWith(window.location.origin);
                const src = node.getAttribute('src');
                const data = node.getAttribute('data');
                const srcset = node.getAttribute('srcset');

                if (srcset) {
                    const srcsetUrls = srcset.split(',');

                    for (const srcsetUrl of srcsetUrls) {
                        const [url] = srcsetUrl.trim().split(' ');

                        if (isExternalUrl(url)) {
                            console.warn('External media blocked', url);
                            node.remove();
                            mediaBlocked = true;
                            break;
                        }
                    }
                }

                if (src && isExternalUrl(src)) {
                    console.warn('External media blocked', src);
                    mediaBlocked = true;
                    node.remove();
                }

                if (data && isExternalUrl(data)) {
                    console.warn('External media blocked', data);
                    mediaBlocked = true;
                    node.remove();
                }

                if (mediaBlocked && (node instanceof HTMLMediaElement)) {
                    node.autoplay = false;
                    node.pause();
                }
            }
                break;
        }

        if (mediaBlocked) {
            const entityId = getCurrentEntityId();
            const warningShownKey = `mediaWarningShown:${entityId}`;

            if (accountStorage.getItem(warningShownKey) === null) {
                const warningToast = toastr.warning(
                    t`Use the 'Ext. Media' button to allow it. Click on this message to dismiss.`,
                    t`External media has been blocked`,
                    {
                        timeOut: 0,
                        preventDuplicates: true,
                        onclick: () => toastr.clear(warningToast),
                    },
                );

                accountStorage.setItem(warningShownKey, 'true');
            }
        }
    });
}

/**
 * @param {number} messageId Message ID
 * @param {JQuery<HTMLElement>} element Message element
 * @param {string} direction Swipe direction
 * @returns {Promise<void>}
 */
async function onImageSwiped(messageId, element, direction) {
    const animationClass = 'fa-fade';
    const messageMedia = element.find('.mes_img, .mes_video');

    // Current image is already animating
    if (messageMedia.hasClass(animationClass)) {
        return;
    }

    const message = chat[messageId];
    const media = message?.extra?.media;

    if (!message || !Array.isArray(media) || media.length === 0) {
        console.warn('No media found in the message');
        return;
    }

    const currentIndex = getMediaIndex(message);
    const mediaDisplay = getMediaDisplay(message);

    if (mediaDisplay !== MEDIA_DISPLAY.GALLERY) {
        console.warn('Image swiping is only supported for gallery media display');
        return;
    }

    if (media.length === 1) {
        console.warn('Only one media item in the message, swiping is not applicable');
        return;
    }

    if (direction === SWIPE_DIRECTION.LEFT) {
        const newIndex = currentIndex === 0 ? media.length - 1 : currentIndex - 1;
        updateIn(messageId, ['extra', 'media_index'], newIndex);
    }

    if (direction === SWIPE_DIRECTION.RIGHT) {
        const newIndex = currentIndex === media.length - 1 ? 0 : currentIndex + 1;
        updateIn(messageId, ['extra', 'media_index'], newIndex >= media.length ? 0 : newIndex);
    }

    await chatOpEdit(messageId).catch(error =>
        console.error('Could not save the swiped media index for that message:', error));
    appendMediaToMessage(chat[messageId], element);
}

export function initChatUtilities() {
    migrateAllowGlobalStylesToDb();

    $(document).on('click', '.mes_hide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, false);
    });

    $(document).on('click', '.mes_unhide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, true);
    });

    $(document).on('click', '.mes_file_delete', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        const fileBlock = $(this).closest('.mes_file_container');
        const fileIndex = Number(fileBlock.attr('data-index'));
        await deleteMessageFile(messageBlock, messageId, fileIndex);
    });

    $(document).on('click', '.mes_file_open', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        const fileBlock = $(this).closest('.mes_file_container');
        const fileIndex = Number(fileBlock.attr('data-index'));
        await viewMessageFile(messageId, fileIndex);
    });

    $(document).on('click', '.assistant_note_export', async function (_e) {
        /** @type {ChatHeader} */
        const chatHeader = {
            chat_metadata: chat_metadata,
            user_name: 'unused',
            character_name: 'unused',
        };
        const chatToSave = [
            chatHeader,
            ...chat.filter(x => x?.extra?.type !== system_message_types.ASSISTANT_NOTE),
        ];

        download(chatToSave.map((m) => JSON.stringify(m)).join('\n'), `Assistant - ${humanizedDateTime()}.jsonl`, 'application/json');
    });

    $(document).on('click', '.assistant_note_import', async function () {
        const importFile = async () => {
            const file = fileInput.files[0];
            if (!file) {
                return;
            }

            try {
                const text = await getFileText(file);
                const lines = text.split('\n').filter(line => line.trim() !== '');
                const messages = lines.map(line => JSON.parse(line));
                const metadata = messages.shift()?.chat_metadata || {};
                messages.unshift(getSystemMessageByType(system_message_types.ASSISTANT_NOTE));
                await clearChat();
                chat.splice(0, chat.length, ...messages);
                updateChatMetadata(metadata, true);
                await printMessages();
            } catch (error) {
                console.error('Error importing assistant chat:', error);
                toastr.error(t`It's either corrupted or not a valid JSONL file.`, t`Failed to import chat`);
            }
        };
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.jsonl';
        fileInput.addEventListener('change', importFile);
        fileInput.click();
    });

    const fileInput = document.getElementById('file_form_input');

    // Do not change. #attachFile is added by extension.
    $(document).on('click', '#attachFile', function () {
        if (!(fileInput instanceof HTMLInputElement)) return;
        const $fileInput = $(fileInput);

        // Preserve existing files in DataTransfer
        const dataTransfer = new DataTransfer();
        for (const file of fileInput.files) {
            dataTransfer.items.add(file);
        }

        $fileInput.off('change').on('change', async () => {
            for (const file of fileInput.files) {
                if (!Array.from(dataTransfer.files).some(f => isSameFile(f, file))) {
                    dataTransfer.items.add(file);
                }
            }

            fileInput.files = dataTransfer.files;
            await onFileAttach(fileInput.files);
        });

        $fileInput.trigger('click');
    });

    $(document).on('click', '.mes_embed', function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        embedMessageFile(messageId, messageBlock);
    });

    $(document).on('click', '.editor_maximize', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const broId = $(this).attr('data-for');
        const bro = $(`#${broId}`);
        const contentEditable = bro.is('[contenteditable]');
        const withTab = $(this).attr('data-tab');

        if (!bro.length) {
            console.error('Could not find editor with id', broId);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('height100p', 'wide100p', 'flex-container');
        wrapper.classList.add('flexFlowColumn', 'justifyCenter', 'alignitemscenter');
        const textarea = document.createElement('textarea');
        textarea.dataset.for = broId;
        if (bro[0].dataset.macros !== undefined) {
            textarea.dataset.macros = bro[0].dataset.macros;
            textarea.dataset.macrosAutocomplete = 'always'; // Always show autocomplete in expanded editor
            textarea.dataset.macrosAutocompleteStyle = 'expanded'; // Use expanded autocomplete style
        }
        textarea.value = String(contentEditable ? bro[0].innerText : bro.val());
        textarea.classList.add('height100p', 'wide100p', 'maximized_textarea');
        bro.hasClass('monospace') && textarea.classList.add('monospace');
        bro.hasClass('mdHotkeys') && textarea.classList.add('mdHotkeys');
        textarea.addEventListener('input', function () {
            if (contentEditable) {
                bro[0].innerText = textarea.value;
            } else {
                bro[0].value = textarea.value;
            }
            bro[0].dispatchEvent(new Event('input', { bubbles: true }));
        });
        const committed = () => bro[0].dispatchEvent(new Event('change', { bubbles: true }));
        wrapper.appendChild(textarea);

        if (textarea.dataset.macros !== undefined) {
            const previewButton = document.createElement('i');
            previewButton.className = 'macro_preview_button fa-solid fa-wand-magic-sparkles right_menu_button';
            previewButton.dataset.for = broId;
            previewButton.title = t`Preview with macros substituted`;
            wrapper.insertBefore(previewButton, textarea);
        }

        if (withTab) {
            textarea.addEventListener('keydown', (evt) => {
                if (evt.key == 'Tab' && !evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    if (end - start > 0 && textarea.value.substring(start, end).includes('\n')) {
                        const lineStart = textarea.value.lastIndexOf('\n', start);
                        const count = textarea.value.substring(lineStart, end).split('\n').length - 1;
                        textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n/g, '\n\t')}${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + count;
                    } else {
                        textarea.value = `${textarea.value.substring(0, start)}\t${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + 1;
                    }
                } else if (evt.key == 'Tab' && evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const lineStart = textarea.value.lastIndexOf('\n', start);
                    const count = textarea.value.substring(lineStart, end).split('\n\t').length - 1;
                    textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n\t/g, '\n')}${textarea.value.substring(end)}`;
                    textarea.selectionStart = start - 1;
                    textarea.selectionEnd = end - count;
                }
            });
        }

        if (this.closest('dialog:modal')) {
            await callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', { wide: true, large: true });
            committed();
            return;
        }
        openEditorLayer(wrapper, {
            closeTitle: t`Restore`,
            onClose: () => {
                committed();
                if (bro[0].isConnected) bro[0].focus({ preventScroll: true });
            },
        });
        textarea.focus();
    });

    $(document).on('click', '.macro_preview_button', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const broId = $(this).attr('data-for');
        const bro = $(`#${broId}`);

        if (!bro.length) {
            console.error('Could not find field to preview macros for', broId);
            return;
        }

        const rawText = String(bro.val());
        const [previewText] = await fetchMacroValues([rawText], openChatMacroScope(), { all: true });
        const pre = $('<pre class="justifyLeft" style="white-space: pre-wrap; word-break: break-word;"></pre>').text(previewText ?? rawText);
        await callGenericPopup(pre, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
    });

    $(document).on('click', 'body .mes .mes_text, body .mes .mes_reasoning', function (event) {
        if (!power_user.click_to_edit) return;
        if ($(event.target).closest('a[href]', this).length) return;
        if (window.getSelection().toString()) return;
        if ($('.edit_textarea').length) return;
        $(this).closest('.mes').find('.mes_edit').trigger('click');
        if ($(event.target).closest('.mes_reasoning').length) {
            $('.reasoning_edit_textarea').trigger('focus');
        }
    });

    $(document).on('click', '.open_media_overrides', openExternalMediaOverridesDialog);
    $(document).on('input', '#forbid_media_override_allowed', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides.push(entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced('power_user.external_media_allowed_overrides', 'power_user.external_media_forbidden_overrides');
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_forbidden', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_forbidden_overrides.push(entityId);
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced('power_user.external_media_forbidden_overrides', 'power_user.external_media_allowed_overrides');
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_global', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced('power_user.external_media_allowed_overrides', 'power_user.external_media_forbidden_overrides');
        reloadCurrentChat();
    });

    $('#creators_note_styles_button').on('click', function (e) {
        e.stopPropagation();
        openGlobalStylesPreferenceDialog();
    });

    /**
     * @returns {MediaContainerInfo} Information about the media container
     * @typedef {object} MediaContainerInfo
     * @property {JQuery<HTMLElement>} messageBlock The closest message block
     * @property {number} messageId The message ID
     * @property {JQuery<HTMLElement>} mediaBlock The closest media container block
     * @property {number} mediaIndex The media index within the message
     */
    function getMediaContainerInfo(containerClass = '.mes_media_container') {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        const mediaBlock = $(this).closest(containerClass);
        const mediaIndex = Number(mediaBlock.attr('data-index'));
        return { messageBlock, messageId, mediaBlock, mediaIndex };
    }
    chatElement.on('click', '.mes_img', async function () {
        const { messageId, mediaIndex } = getMediaContainerInfo.call(this);
        expandMessageMedia(messageId, mediaIndex);
    });
    initImageLightbox(showMediaLightbox);
    chatElement.on('click', '.mes_text img, .mes_reasoning img, .mes_bias img', onLightboxImageClick);
    $(document).on('click', '.field_preview img', onLightboxImageClick);
    chatElement.on('click', '.mes_media_enlarge', async function () {
        const { messageId, mediaIndex } = getMediaContainerInfo.call(this);
        expandMessageMedia(messageId, mediaIndex).click();
    });
    chatElement.on('click', '.mes_media_delete', async function () {
        const { messageId, mediaIndex, messageBlock } = getMediaContainerInfo.call(this);
        await deleteMessageMedia(messageId, mediaIndex, messageBlock);
    });
    chatElement.on('click', '.mes_media_list', async function () {
        const { messageId, messageBlock } = getMediaContainerInfo.call(this);
        await switchMessageMediaDisplay(messageId, messageBlock, MEDIA_DISPLAY.GALLERY);
    });
    chatElement.on('click', '.mes_media_gallery', async function () {
        const { messageId, messageBlock } = getMediaContainerInfo.call(this);
        await switchMessageMediaDisplay(messageId, messageBlock, MEDIA_DISPLAY.LIST);
    });
    chatElement.on('click', '.mes_img_swipe_left', async function () {
        const { messageId, messageBlock } = getMediaContainerInfo.call(this);
        await onImageSwiped(messageId, messageBlock, SWIPE_DIRECTION.LEFT);
    });
    chatElement.on('click', '.mes_img_swipe_right', async function () {
        const { messageId, messageBlock } = getMediaContainerInfo.call(this);
        await onImageSwiped(messageId, messageBlock, SWIPE_DIRECTION.RIGHT);
    });

    $('#file_form').on('reset', function () {
        $('#file_form').addClass('displayNone');
    });

    document.getElementById('send_textarea').addEventListener('paste', async function (event) {
        if (event.clipboardData.files.length === 0) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        await handleFileAttach(Array.from(event.clipboardData.files));
    });

    new DragAndDropHandler('#form_sheld', async (files) => {
        await handleFileAttach(files);
    });

    /**
     * @param {File[]} files Files to attach
     * @returns {Promise<void>}
     */
    async function handleFileAttach(files) {
        if (!(fileInput instanceof HTMLInputElement)) return;

        // Workaround for Firefox: Use a DataTransfer object to indirectly set fileInput.files
        const dataTransfer = new DataTransfer();
        for (const file of fileInput.files) {
            dataTransfer.items.add(file);
        }

        // Preserve existing non-duplicate files in the input
        for (const file of files) {
            if (!Array.from(dataTransfer.files).some(f => isSameFile(f, file))) {
                dataTransfer.items.add(file);
            }
        }

        fileInput.files = dataTransfer.files;
        await onFileAttach(fileInput.files);
    }

    eventSource.on(event_types.CHAT_CHANGED, checkForCreatorNotesStyles);
}
