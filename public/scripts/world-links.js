import { create_save, getCurrentChatId, menu_type, saveCharacterField, settingsValueStored } from '../script.js';
import { chat_metadata } from './chat-state.js';
import { charactersStore } from './character-store.js';
import { character_world_link, resolveCharacterWorldLink } from './character-world-link.js';
import { eventSource, event_types } from './events.js';
import { t } from './i18n.js';
import { saveMetadata } from './metadata-store.js';
import { newUi, newUiStarted } from './new-ui-page.js';
import { setPersonaDescription } from './personas.js';
import { personaStore, power_user } from './power-user.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { getRequestHeaders } from './request-headers.js';
import { renderTemplateAsync } from './templates.js';
import { addLongPressEvent, normalizeArray } from './utils.js';

/**
 * Which worlds a character, a chat and a persona use, as the old page shows and changes them. The worlds themselves
 * are the worldbuilding page's: their list is its view, and opening one shows it there.
 */

export const METADATA_KEY = 'world_info';

/** @type {{ name: string, extraBooks: string[] }[]} */
let charLore = [];

/**
 * @returns {import('/ui/entry.js').NewUi['worldbuilding'] | null}
 */
function page() {
    return newUiStarted() ? newUi().worldbuilding : null;
}

/**
 * Null until the server's first answer is here.
 * @returns {{ id: string, name: string, entries: number, usedInEveryChat: boolean }[] | null}
 */
export function worlds() {
    return page()?.worlds() ?? null;
}

/**
 * @returns {string[]}
 */
export function worldNames() {
    return worlds()?.map(world => world.name) ?? [];
}

/**
 * Until the list is here, a name is taken as known, so nothing is marked missing before it is.
 * @param {string} name
 * @returns {boolean}
 */
function worldKnown(name) {
    const known = worlds();
    return known === null || known.some(world => world.name === name);
}

/**
 * @param {string} name
 */
export function openWorld(name) {
    page()?.openWorld(name);
}

/**
 * @param {string} thing The character's entity id.
 */
export function openCharacterBook(thing) {
    page()?.openCharacterBook(thing);
}

/**
 * @param {File} file
 */
export function importWorld(file) {
    page()?.importWorld(file);
}

/**
 * @param {Record<string, any>} settings The settings answer's `world_info_settings`.
 */
export function takeCharLore(settings) {
    const held = settings?.world_info?.charLore;
    charLore = Array.isArray(held) ? held.filter(e => typeof e?.name === 'string' && Array.isArray(e.extraBooks)) : [];
}

/**
 * @param {string | undefined} fileName The character's file name, without its extension.
 * @returns {string[]}
 */
export function extraBooksOf(fileName) {
    return charLore.find(e => e.name === fileName)?.extraBooks ?? [];
}

/**
 * @param {string} oldName
 * @param {string} newName
 */
export function renameCharLore(oldName, newName) {
    const held = charLore.find(e => e.name === oldName);
    if (held) held.name = newName;
}

/**
 * Holds a character's additional books as the server answered them.
 * @param {string} fileName The character's file name, without its extension.
 * @param {string[]} extraBooks
 */
export function takeAuxBooks(fileName, extraBooks) {
    charLore = charLore.filter(e => e.name !== fileName);
    if (extraBooks.length) charLore.push({ name: fileName, extraBooks });
}

/**
 * @param {string} fileName
 * @param {'add'|'set'|'remove'} op
 * @param {string[]} books
 * @returns {Promise<boolean>}
 */
export async function sendAuxBooksOp(fileName, op, books) {
    try {
        const response = await fetch('/api/worldinfo/additional-books', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ characterAvatar: fileName, op, books }),
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            toastr.error(data?.error || t`Failed to update additional lorebooks`);
            return false;
        }
        const { extraBooks } = await response.json();
        takeAuxBooks(fileName, extraBooks);
        return true;
    } catch (error) {
        console.error('Failed to update additional lorebooks', error);
        toastr.error(t`Failed to update additional lorebooks`);
        return false;
    }
}

/**
 * @param {string | undefined} fileName
 * @param {string[]} books
 */
export async function charSetAuxWorlds(fileName, books) {
    const list = Array.isArray(books) ? books : [];
    if (menu_type === 'create') {
        create_save.extra_books = normalizeArray(list);
        return;
    }
    if (!fileName) return;
    await sendAuxBooksOp(fileName, 'set', list);
}

/**
 * @param {string} name A world's name, or '' for none.
 */
export async function charUpdatePrimaryWorld(name) {
    $('#character_world').val(name);
    if (menu_type == 'create') {
        create_save.world = name;
        updateCharacterWorldButton();
        return;
    }
    await saveCharacterField(String($('#avatar_url_pole').val()), '#character_world', name);
    updateCharacterWorldButton();
}

/**
 * @param {{data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 * @returns {string}
 */
export function getCharacterWorldLink(character) {
    return resolveCharacterWorldLink(character, worldKnown);
}

let worldButtonTitle = null;

/**
 * @param {string|null} missingName
 */
function setWorldButtonMissing(missingName) {
    const button = $('#world_button');
    button.toggleClass('warning', missingName !== null);
    if (missingName !== null) {
        worldButtonTitle ??= button.attr('title') ?? null;
        button.attr('title', t`Linked lorebook "${missingName}" not found`);
    } else if (worldButtonTitle !== null && button.attr('title') !== worldButtonTitle) {
        button.attr('title', worldButtonTitle);
    }
}

/**
 * @param {{shallow?: boolean, data?: {extensions?: {world?: string}, character_book?: object}}|null|undefined} character
 */
function showCharacterWorldLink(character) {
    const worldLink = getCharacterWorldLink(character);
    const worldSet = worldLink === character_world_link.FILE || worldLink === character_world_link.EMBEDDED;
    $('#set_character_world, #world_button').toggleClass('world_set', worldSet);
    const missing = worldLink === character_world_link.MISSING && character?.shallow !== true;
    setWorldButtonMissing(missing ? character.data.extensions.world : null);
}

/**
 * Shows the character panel's links to the character's worlds: its world, and its own lorebook when its card has one.
 * @param {string|undefined} avatar
 */
export function setWorldInfoButtonClass(avatar) {
    const character = avatar === undefined ? undefined : charactersStore.get(avatar);
    $('#edit_embedded_lore').toggle(Boolean(character?.data?.character_book));
    if (avatar !== undefined) showCharacterWorldLink(character);
}

export function updateCharacterWorldButton() {
    if (menu_type == 'create') {
        $('#edit_embedded_lore').hide();
        showCharacterWorldLink({ data: { extensions: { world: create_save.world } } });
        return;
    }
    const avatar = $('#set_character_world').data('avatar');
    if (avatar === undefined || avatar === null) return;
    setWorldInfoButtonClass(avatar);
}

function showChatWorld() {
    const name = chat_metadata[METADATA_KEY];
    $('.chat_lorebook_button').toggleClass('world_set', !!name && worldKnown(name));
}

/**
 * @param {string} name A world's name, or '' for none.
 */
export async function setChatWorld(name) {
    if (name) chat_metadata[METADATA_KEY] = name;
    else delete chat_metadata[METADATA_KEY];
    showChatWorld();
    await saveMetadata();
}

/**
 * @param {Pick<JQuery.ClickEvent, 'shiftKey' | 'altKey'>} event
 */
async function assignLorebookToChat({ shiftKey, altKey }) {
    const selectedName = chat_metadata[METADATA_KEY];
    if (selectedName && worldKnown(selectedName) && !shiftKey && !altKey) {
        openWorld(selectedName);
        return;
    }
    const template = $(await renderTemplateAsync('chatLorebook'));
    const worldSelect = template.find('select');
    template.find('.chat_name').text(getCurrentChatId());
    for (const worldName of worldNames()) {
        worldSelect.append(new Option(worldName, worldName, false, selectedName === worldName));
    }
    worldSelect.on('change', function () {
        void setChatWorld(String($(this).val() ?? ''));
    });
    await callGenericPopup(template, POPUP_TYPE.TEXT);
}

/**
 * Follows a world's rename or deletion in what the page holds of its links; the server has already changed the stored
 * ones.
 * @param {string} from
 * @param {string} to '' when the world is gone.
 */
function followWorld(from, to) {
    const renamed = (/** @type {string[]} */ books) => normalizeArray(books.map(book => (book === from ? to : book)).filter(Boolean));
    if (chat_metadata[METADATA_KEY] === from) {
        if (to) chat_metadata[METADATA_KEY] = to;
        else delete chat_metadata[METADATA_KEY];
    }
    if (menu_type == 'create') {
        if (create_save.world === from) create_save.world = to;
        if (Array.isArray(create_save.extra_books)) create_save.extra_books = renamed(create_save.extra_books);
    }
    if ($('#character_world').val() === from) $('#character_world').val(to);
    charLore = charLore.map(e => ({ ...e, extraBooks: renamed(e.extraBooks) })).filter(e => e.extraBooks.length);
    let personas = false;
    for (const [avatar, persona] of Object.entries(personaStore.getAll())) {
        if (persona?.lorebook !== from) continue;
        personaStore.update(avatar, { lorebook: to });
        personas = true;
    }
    if (!personas) return;
    settingsValueStored('power_user.persona_data', power_user.persona_data);
    setPersonaDescription();
}

/** @type {Map<string, string> | null} */
let namesById = null;

function takeWorlds() {
    const known = worlds();
    if (known === null) return;
    const now = new Map(known.map(world => [world.id, world.name]));
    for (const [id, name] of namesById ?? []) {
        const next = now.get(id) ?? '';
        if (next !== name) followWorld(name, next);
    }
    namesById = now;
    updateCharacterWorldButton();
    showChatWorld();
}

export function initWorldLinks() {
    charactersStore.onChange((change) => {
        if (change.op === 'reset' || (change.op === 'updated' && change.id === $('#set_character_world').data('avatar'))) {
            updateCharacterWorldButton();
        }
    });
    page()?.watchWorlds(takeWorlds);
    takeWorlds();
    eventSource.on(event_types.CHAT_CHANGED, showChatWorld);

    $('#world_button').on('click', function (event) {
        const openSetWorldMenu = () => $('#char-management-dropdown').val($('#set_character_world').val()).trigger('change');
        const avatar = $('#set_character_world').data('avatar');
        const worldName = avatar === null || avatar === undefined ? undefined : charactersStore.get(avatar)?.data?.extensions?.world;
        if (worldName && worldNames().includes(worldName) && !event.shiftKey && !event.altKey) {
            openWorld(worldName);
        } else {
            openSetWorldMenu();
        }
    });
    addLongPressEvent('#world_button', function () {
        $(this).trigger($.Event('click', { shiftKey: true }));
    });

    $(document).on('click', '.chat_lorebook_button', assignLorebookToChat);
    addLongPressEvent('.chat_lorebook_button', function () {
        void assignLorebookToChat({ shiftKey: true, altKey: false });
    });
    $('#group-chat-lorebook-dropdown').on('change', async function () {
        $(this).prop('selectedIndex', 0);
        await assignLorebookToChat({ shiftKey: true, altKey: false });
    });
}
