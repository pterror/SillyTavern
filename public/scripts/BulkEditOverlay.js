'use strict';

import {
    characterGroupOverlay,
    buildAvatarList,
    deleteCharacter,
    closeCurrentChat,
    removeCharacterFromUI,
    getPastCharacterChats,
} from '../script.js';
import { getCharacters, characterToEntity, getCharacterListPageContext, removeCharacterListRow } from './character-list.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore, this_avatar } from './character-store.js';
import { event_types, eventSource } from './events.js';

import { favsToHotswap } from './RossAscends-mods.js';
import { loader } from './action-loader.js';
import { convertCharacterToPersona, convertCharactersToPersonas } from './personas.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { createTagInput, printTagList, compareTagsForSort, readTagsForIds, removeEntityTags, rereadResidentEntityTagIds, tagsStore } from './tags.js';
import { t } from './i18n.js';
import { escapeHtml } from './utils.js';
import { accountStorage } from './util/AccountStorage.js';
import { emptySelection, isSelected, setOne, setRange, setAll, isEverything, isEmpty, countSelection, selectionToWire } from './bulk-selection.js';

/**
 * @typedef {object} PreparedSelection A selection the server has fixed as a job (`/api/characters/bulk/prepare`).
 * @property {string} job
 * @property {number} count How many characters it holds.
 * @property {boolean} containsCurrent Whether the current character is one of them.
 * @property {string[]} sample Its first avatars.
 */

/**
 * @param {object} wire A selection as `selectionToWire()` gives it.
 * @returns {Promise<PreparedSelection|null>} `null` when the server couldn't fix it (already said so).
 */
async function prepareSelection(wire) {
    const response = await fetch('/api/characters/bulk/prepare', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ selection: wire, current: this_avatar }),
    });
    if (!response.ok) {
        toastr.error(t`The selected characters could not be read.`, t`Bulk edit`);
        return null;
    }
    const prepared = await response.json();
    if (Array.isArray(prepared.missing) && prepared.missing.length > 0) {
        toastr.warning(t`These selected characters no longer exist, so they are left out:` + `<br />${prepared.missing.map(escapeHtml).join('<br />')}`,
            t`Bulk edit`, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
    }
    return prepared;
}

/** @param {string} job */
function dropPrepared(job) {
    fetch('/api/characters/bulk/drop', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ job }),
    }).catch(error => console.warn('Could not drop a bulk selection:', error));
}

/**
 * A prepared selection's avatars, a page at a time.
 * @param {string} job
 * @returns {AsyncGenerator<string[], void, undefined>}
 */
async function* preparedAvatars(job) {
    let after = '';
    for (;;) {
        const response = await fetch('/api/characters/bulk/ids', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ job, after }),
        });
        if (!response.ok) throw new Error(`/api/characters/bulk/ids failed with ${response.status}`);
        const { avatars, more } = await response.json();
        if (avatars.length > 0) yield avatars;
        if (!more || avatars.length === 0) return;
        after = avatars[avatars.length - 1];
    }
}

/**
 * The characters whose results the page wants sent back: the ones it holds, and the rows on screen.
 * @returns {string[]}
 */
function watchedAvatars() {
    const avatars = new Set(charactersStore.getAll().map(character => character.avatar));
    for (const row of document.querySelectorAll(`#${BulkEditOverlay.containerId} .${BulkEditOverlay.characterClass}[data-avatar]`)) {
        avatars.add(row.getAttribute('data-avatar'));
    }
    return [...avatars];
}

/**
 * A toast showing how far a bulk action is, updated in place.
 * @param {string} title
 * @param {number} total
 */
function progressToast(title, total) {
    const message = (/** @type {number} */ done) => t`${done} of ${total} done…`;
    const toast = toastr.info(message(0), title, { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    return {
        update: (/** @type {number} */ done) => toast?.find?.('.toast-message')?.text(message(done)),
        close: () => toastr.clear(toast),
    };
}

/**
 * Runs an action on every character of a prepared selection (`/api/characters/bulk/run`), as the server streams its
 * progress back.
 * @param {PreparedSelection} prepared
 * @param {string} action
 * @param {object} options
 * @param {string} title For the progress toast.
 * @param {(line: { avatar: string, [key: string]: any }) => Promise<void>|void} [onItem] For each watched character done.
 * @returns {Promise<{ done: number, failed: { avatar: string, error: string }[], stopped: boolean }>}
 */
async function runPrepared(prepared, action, options, title, onItem) {
    const progress = progressToast(title, prepared.count);
    /** @type {{ avatar: string, error: string }[]} */
    const failed = [];
    let done = 0;
    let finished = false;
    try {
        const response = await fetch('/api/characters/bulk/run', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ job: prepared.job, action, options, watch: watchedAvatars() }),
        });
        if (!response.ok || !response.body) {
            return { done, failed, stopped: true };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = '';
        for (;;) {
            const { value, done: ended } = await reader.read();
            buffered += decoder.decode(value ?? new Uint8Array(), { stream: !ended });
            let newline;
            while ((newline = buffered.indexOf('\n')) !== -1) {
                const text = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                if (!text.trim()) continue;
                const line = JSON.parse(text);
                switch (line.type) {
                    case 'item':
                        await onItem?.(line);
                        break;
                    case 'failed':
                        failed.push({ avatar: line.avatar, error: line.error });
                        break;
                    case 'progress':
                        done = line.done;
                        progress.update(line.done + line.failed);
                        break;
                    case 'done':
                        done = line.done;
                        finished = true;
                        break;
                    case 'error':
                        done = line.done;
                        break;
                }
            }
            if (ended) break;
        }
    } catch (error) {
        console.error(`Bulk ${action} failed:`, error);
    } finally {
        progress.close();
    }
    return { done, failed, stopped: !finished };
}

/**
 * Says what a bulk action didn't do: every character that failed, and whether it stopped before the end.
 * @param {string} title
 * @param {{ failed: { avatar: string }[], stopped: boolean }} result
 * @param {(avatar: string) => string} [nameOf]
 */
function reportBulkProblems(title, result, nameOf = avatar => avatar) {
    if (result.failed.length > 0) {
        toastr.error(t`These characters were not done:` + `<br />${result.failed.map(entry => escapeHtml(nameOf(entry.avatar))).join('<br />')}`,
            title, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
    }
    if (result.stopped) {
        toastr.error(t`It stopped before the end. The characters it hadn't reached yet were not done.`, title, { timeOut: 0, extendedTimeOut: 0 });
    }
}

/**
 * Removes the per-character browser keys of characters that no longer exist.
 */
async function forgetDeletedCharactersInBrowser() {
    const prefixes = ['AlertRegex_', 'mediaWarningShown:'];
    /** @type {Map<string, string[]>} */
    const keysByAvatar = new Map();
    for (const key of Object.keys(accountStorage.getState())) {
        const prefix = prefixes.find(p => key.startsWith(p));
        if (!prefix) continue;
        const avatar = key.slice(prefix.length);
        keysByAvatar.set(avatar, [...(keysByAvatar.get(avatar) ?? []), key]);
    }
    const avatars = [...keysByAvatar.keys()];
    for (let start = 0; start < avatars.length; start += 500) {
        const chunk = avatars.slice(start, start + 500);
        const response = await fetch('/api/characters/exists', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ids: chunk }) });
        if (!response.ok) return;
        const exists = await response.json();
        for (const avatar of chunk) {
            if (exists[avatar] === false) keysByAvatar.get(avatar).forEach(key => accountStorage.removeItem(key));
        }
    }
}

/**
 * Static object representing the actions of the
 * character context menu override.
 */
class CharacterContextMenu {
    /**
     * Tag one or more characters,
     * opens a popup.
     *
     * @param {Array<string>} selectedCharacters
     */
    static tag = (selectedCharacters) => {
        characterGroupOverlay.bulkTagPopupHandler.show(selectedCharacters);
    };

    /**
     * Duplicate one or more characters
     *
     * @param {string} avatar
     * @returns {Promise<any>}
     */
    static duplicate = async (avatar) => {
        const body = { avatar_url: avatar };

        const result = await fetch('/api/characters/duplicate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!result.ok) {
            throw new Error('Character not duplicated');
        }

        const data = await result.json();
        await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: body.avatar_url, newAvatar: data.path });
    };

    /**
     * Duplicate one or more characters in a single batch request.
     *
     * @param {string[]} avatars
     * @returns {Promise<void>}
     */
    static duplicateBulk = async (avatars) => {
        if (avatars.length === 0) return;

        const result = await fetch('/api/characters/duplicate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_urls: avatars }),
        });

        if (!result.ok) {
            throw new Error('Characters not duplicated');
        }

        const data = await result.json();
        for (const entry of data.results ?? []) {
            if (entry.ok) {
                await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: entry.avatar_url, newAvatar: entry.path });
            } else {
                toastr.error(t`Failed to duplicate character ${entry.avatar_url}.`);
            }
        }
    };

    /**
     * Favorite a character
     * and highlight it.
     *
     * @param {string} avatar
     * @returns {Promise<void>}
     */
    static favorite = async (avatar) => {
        const favResponse = await fetch('/api/characters/fav', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, toggle: true }),
        });

        if (!favResponse.ok) {
            toastr.error(t`Failed to update favorite status.`);
            return;
        }

        const { fav } = await favResponse.json();
        CharacterContextMenu.applyFav(avatar, fav);
    };

    /**
     * Shows a stored fav value on the held copy, if any, and on the character's list row.
     * @param {string} avatar
     * @param {boolean} fav
     */
    static applyFav = (avatar, fav) => {
        const character = charactersStore.get(avatar);
        if (character) {
            character.fav = fav;
            if (character.data?.extensions) character.data.extensions.fav = fav;
        }
        const element = document.querySelector(`[data-avatar="${CSS.escape(avatar)}"]`);
        element?.classList.toggle('is_fav', fav);
    };

    /**
     * Toggle favorite status for one or more characters in a single batch request.
     *
     * @param {string[]} avatars
     * @returns {Promise<void>}
     */
    static favoriteBulk = async (avatars) => {
        if (avatars.length === 0) return;

        const favResponse = await fetch('/api/characters/fav', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ bulk: avatars.map(avatar => ({ avatar, toggle: true })) }),
        });

        if (!favResponse.ok) {
            toastr.error(t`Failed to update favorite status.`);
            return;
        }

        const data = await favResponse.json();
        const stored = new Map((data.results ?? []).filter(entry => entry.ok).map(entry => [entry.avatar, entry.fav]));

        const failed = [];
        for (const avatar of avatars) {
            if (!stored.has(avatar)) {
                failed.push(avatar);
                continue;
            }
            CharacterContextMenu.applyFav(avatar, stored.get(avatar));
        }
        if (failed.length) {
            toastr.error(t`Failed to update favorite status for:` + `<br />${failed.map(escapeHtml).join('<br />')}`, '', { escapeHtml: false });
        }
    };

    /**
     * Convert one or more characters to persona,
     * may open a popup for one or more characters.
     *
     * @param {string} avatar
     * @returns {Promise<void>}
     */
    static persona = async (avatar) => void (await convertCharacterToPersona(avatar));

    /**
     * Delete one or more characters,
     * opens a popup.
     *
     * @param {string|string[]} characterKey
     * @param {boolean} [deleteChats]
     * @returns {Promise<void>}
     */
    static delete = async (characterKey, deleteChats = false) => {
        await deleteCharacter(characterKey, { deleteChats: deleteChats });
    };

    /**
     * Show the context menu at the given position
     *
     * @param positionX
     * @param positionY
     */
    static show = (positionX, positionY) => {
        let contextMenu = document.getElementById(BulkEditOverlay.contextMenuId);
        contextMenu.style.left = `${positionX}px`;
        contextMenu.style.top = `${positionY}px`;

        document.getElementById(BulkEditOverlay.contextMenuId).classList.remove('hidden');

        // Adjust position if context menu is outside of viewport
        const boundingRect = contextMenu.getBoundingClientRect();
        if (boundingRect.right > window.innerWidth) {
            contextMenu.style.left = `${positionX - (boundingRect.right - window.innerWidth)}px`;
        }
        if (boundingRect.bottom > window.innerHeight) {
            contextMenu.style.top = `${positionY - (boundingRect.bottom - window.innerHeight)}px`;
        }
    };

    /**
     * Hide the context menu
     */
    static hide = () => document.getElementById(BulkEditOverlay.contextMenuId).classList.add('hidden');

    /**
     * Sets up the context menu for the given overlay
     *
     * @param characterGroupOverlay
     */
    constructor(characterGroupOverlay) {
        const contextMenuItems = [
            { id: 'character_context_menu_favorite', callback: characterGroupOverlay.handleContextMenuFavorite },
            { id: 'character_context_menu_duplicate', callback: characterGroupOverlay.handleContextMenuDuplicate },
            { id: 'character_context_menu_delete', callback: characterGroupOverlay.handleContextMenuDelete },
            { id: 'character_context_menu_persona', callback: characterGroupOverlay.handleContextMenuPersona },
            { id: 'character_context_menu_tag', callback: characterGroupOverlay.handleContextMenuTag },
        ];

        contextMenuItems.forEach(contextMenuItem => document.getElementById(contextMenuItem.id).addEventListener('click', contextMenuItem.callback));
    }
}

/**
 * Represents a tag control not bound to a single character
 */
class BulkTagPopupHandler {
    /**
     * The characters named for this popup: the ones passed to show(), or the first ones of the selection.
     * @type {string[]}
     */
    characterIds = [];

    /**
     * A storage of the current mutual tags, as calculated by getMutualTags()
     * @type {object[]}
     */
    currentMutualTags = [];

    /** @type {PreparedSelection|null} */
    #prepared = null;

    /** @type {string[]} The ids of the tags every selected character carries, as the server last said. */
    #mutualTagIds = [];

    /**
     * Sets up the bulk popup menu handler for the given overlay.
     *
     * Characters can be passed in with the show() call.
     */
    constructor() { }

    /**
     * Gets the HTML as a string that is going to be the popup for the bulk tag edit
     *
     * @returns String containing the html for the popup
     */
    #getHtml = () => {
        const count = this.#prepared?.count ?? this.characterIds.length;
        const characterData = JSON.stringify({ characterIds: this.characterIds });
        return `<div id="bulk_tag_shadow_popup">
            <div id="bulk_tag_popup" class="wider_dialogue_popup">
                <div id="bulk_tag_popup_holder">
                    <h3 class="marginBot5">${escapeHtml(t`Modify tags of ${count} characters`)}</h3>
                    <small class="bulk_tags_desc m-b-1">Add or remove the mutual tags of all selected characters. Import all or existing tags for all selected characters.</small>
                    <div id="bulk_tags_avatars_block" class="avatars_inline avatars_inline_small tags tags_inline"></div>
                    <br>
                    <div id="bulk_tags_div" class="marginBot5" data-characters='${escapeHtml(characterData)}'>
                        <div class="tag_controls">
                            <input id="bulkTagInput" class="text_pole tag_input wide100p margin0" data-i18n="[placeholder]Search / Create Tags" placeholder="Search / Create tags" maxlength="25" />
                            <div class="tags_view menu_button fa-solid fa-tags" title="View all tags" data-i18n="[title]View all tags"></div>
                        </div>
                        <div id="bulkTagList" class="m-t-1 tags"></div>
                    </div>
                    <div id="dialogue_popup_controls" class="m-t-1">
                        <div id="bulk_tag_popup_reset" class="menu_button" title="Remove all tags from the selected characters" data-i18n="[title]Remove all tags from the selected characters">
                            <i class="fa-solid fa-trash-can margin-right-10px"></i>
                            All
                        </div>
                        <div id="bulk_tag_popup_remove_mutual" class="menu_button" title="Remove all mutual tags from the selected characters" data-i18n="[title]Remove all mutual tags from the selected characters">
                            <i class="fa-solid fa-trash-can margin-right-10px"></i>
                            Mutual
                        </div>
                        <div id="bulk_tag_popup_import_all_tags" class="menu_button" title="Import all tags from selected characters" data-i18n="[title]Import all tags from selected characters">
                            Import All
                        </div>
                        <div id="bulk_tag_popup_import_existing_tags" class="menu_button" title="Import existing tags from selected characters" data-i18n="[title]Import existing tags from selected characters">
                            Import Existing
                        </div>
                        <div id="bulk_tag_popup_cancel" class="menu_button" data-i18n="Cancel">Close</div>
                    </div>
                </div>
            </div>
        </div>`;
    };

    /**
     * Append and show the tag control for these characters.
     *
     * @param {string[]} characterIds - The characters that are shown inside the popup
     */
    async show(characterIds) {
        if (!Array.isArray(characterIds) || characterIds.length === 0) {
            console.log('No characters selected for bulk edit tags.');
            return;
        }
        const prepared = await prepareSelection({ include: characterIds.slice() });
        if (!prepared) return;
        await this.showPrepared(prepared, characterIds.slice());
    }

    /**
     * Append and show the tag control for a prepared selection. The popup owns the selection from here on and drops
     * it when it closes.
     * @param {PreparedSelection} prepared
     * @param {string[]} [characterIds] The characters it was made from, when named one by one.
     */
    async showPrepared(prepared, characterIds = prepared.sample) {
        this.#prepared = prepared;
        this.characterIds = characterIds;
        if (prepared.count === 0) {
            dropPrepared(prepared.job);
            this.#prepared = null;
            return;
        }

        document.body.insertAdjacentHTML('beforeend', this.#getHtml());

        const { characterRepository } = await import('./character-repository.js');
        const characters = await characterRepository.getMany(prepared.sample);
        const entities = prepared.sample.map(avatar => characters.get(avatar)).filter(Boolean).map(character => characterToEntity(character));
        buildAvatarList($('#bulk_tags_avatars_block'), entities);
        if (prepared.count > entities.length) {
            $('#bulk_tags_avatars_block').append($('<div class="bulk_more_note"></div>').text(t`and ${prepared.count - entities.length} more`));
        }

        const listOptions = { tags: () => this.getMutualTags(), tagOptions: { removable: true, removeAction: tag => this.removeTag(tag) } };
        createTagInput('#bulkTagInput', '#bulkTagList', listOptions, { onTagChosen: tag => this.addTag(tag) });

        document.querySelector('#bulk_tag_popup_reset').addEventListener('click', this.resetTags.bind(this));
        document.querySelector('#bulk_tag_popup_remove_mutual').addEventListener('click', this.removeMutual.bind(this));
        document.querySelector('#bulk_tag_popup_cancel').addEventListener('click', this.hide.bind(this));
        document.querySelector('#bulk_tag_popup_import_all_tags').addEventListener('click', this.importAllTags.bind(this));
        document.querySelector('#bulk_tag_popup_import_existing_tags').addEventListener('click', this.importExistingTags.bind(this));

        await this.refresh();
    }

    /**
     * Asks the server which tags every selected character carries, reads their definitions, and draws them.
     */
    async refresh() {
        if (!this.#prepared) return;
        const response = await fetch('/api/characters/bulk/mutual-tags', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ job: this.#prepared.job }),
        });
        if (!response.ok) {
            toastr.error(t`The server could not be asked which tags they have.`, t`Tags could not be read`);
            return;
        }
        const { tagIds } = await response.json();
        this.#mutualTagIds = tagIds;
        await readTagsForIds(tagIds);
        printTagList($('#bulkTagList'), { empty: 'always', tags: () => this.getMutualTags(), tagOptions: { removable: true, removeAction: tag => this.removeTag(tag) } });
    }

    /**
     * Runs a tag action on every selected character, says what failed, and reads the mutual tags again.
     * @param {string} action
     * @param {object} [options]
     */
    async #run(action, options = {}) {
        if (!this.#prepared) return;
        /** @type {string[]} */
        const shown = [];
        const result = await runPrepared(this.#prepared, action, options, t`Bulk tag edit`, line => void shown.push(line.avatar));
        // The characters the page holds or shows take their new tags now.
        if (shown.length) await rereadResidentEntityTagIds(shown);
        reportBulkProblems(t`Bulk tag edit`, result);
        await eventSource.emit(event_types.CHARACTERS_BULK_EDITED, { action, done: result.done, failed: result.failed.length });
        await this.refresh();
    }

    /**
     * Import existing tags for all selected characters
     */
    async importExistingTags() {
        await this.#run('tag-import', { onlyExisting: true });
    }

    /**
     * Import all tags for all selected characters
     */
    async importAllTags() {
        await this.#run('tag-import', { onlyExisting: false });
    }

    /**
     * The ids of the tags every selected character has.
     * @returns {string[]}
     */
    getMutualTagIds() {
        return this.#mutualTagIds.slice();
    }

    /**
     * Builds a list of all tags that the provided characters have in common.
     *
     * @returns {Array<object>} A list of mutual tags
     */
    getMutualTags() {
        this.currentMutualTags = this.#mutualTagIds.map(id => tagsStore.get(id)).filter(Boolean).sort(compareTagsForSort);
        return this.currentMutualTags;
    }

    /** @param {import('./tags.js').Tag} tag */
    async addTag(tag) {
        await this.#run('tag-add', { tagIds: [tag.id] });
    }

    /** @param {import('./tags.js').Tag} tag */
    async removeTag(tag) {
        await this.#run('tag-remove', { tagIds: [tag.id] });
    }

    /**
     * Hide and remove the tag control
     */
    hide() {
        let popupElement = document.querySelector('#bulk_tag_shadow_popup');
        if (popupElement) {
            document.body.removeChild(popupElement);
        }
        if (this.#prepared) dropPrepared(this.#prepared.job);
        this.#prepared = null;
        this.#mutualTagIds = [];

        // No need to redraw here, all tags actions were redrawn when they happened
    }

    /**
     * Empty the tag map for the given characters
     */
    async resetTags() {
        await this.#run('tag-reset');
    }

    /**
     * Remove the mutual tags for all given characters
     */
    async removeMutual() {
        await this.#run('tag-remove', { tagIds: this.getMutualTagIds() });
    }
}

class BulkEditOverlayState {
    /**
     *
     * @type {number}
     */
    static browse = 0;

    /**
     *
     * @type {number}
     */
    static select = 1;
}

/**
 * Implement a SingletonPattern, allowing access to the group overlay instance
 * from everywhere via (new CharacterGroupOverlay())
 *
 * @type {Readonly<BulkEditOverlay>}
 */
let bulkEditOverlayInstance = null;

class BulkEditOverlay {
    static containerId = 'rm_print_characters_block';
    static contextMenuId = 'character_context_menu';
    static characterClass = 'character_select';
    static groupClass = 'group_select';
    static bogusFolderClass = 'bogus_folder_select';
    static selectModeClass = 'group_overlay_mode_select';
    static selectedClass = 'character_selected';
    static legacySelectedClass = 'bulk_select_checkbox';
    static bulkSelectedCountId = 'bulkSelectedCount';

    static longPressDelay = 2500;

    #state = BulkEditOverlayState.browse;
    #longPress = false;
    #stateChangeCallbacks = [];
    #bulkTagPopupHandler = new BulkTagPopupHandler();

    /**
     * What is selected, as rules over the list (bulk-selection.js), never as every selected character.
     * @type {import('./bulk-selection.js').BulkSelection}
     */
    #selection = emptySelection();

    /** The list the selection is over (getCharacterListPageContext().queryKey). Another list clears it. */
    #selectionQueryKey = '';

    /**
     * @typedef {object} LastSelected - An object noting the last selected character and its state.
     * @property {string} [characterId] - The avatar of the last selected character.
     * @property {number} [position] - Its position in the list.
     * @property {boolean} [select] - The selected state of the last selected character. <c>true</c> if it was selected, <c>false</c> if it was deselected.
     */

    /**
     * @type {LastSelected} - An object noting the last selected character and its state.
     */
    lastSelected = { characterId: undefined, position: undefined, select: undefined };

    /**
     * Locks other pointer actions when the context menu is open
     *
     * @type {boolean}
     */
    #contextMenuOpen = false;

    /**
     * Whether the next character select should be skipped
     *
     * @type {boolean}
     */
    #cancelNextToggle = false;

    /**
     * @type HTMLElement
     */
    container = null;

    get state() {
        return this.#state;
    }

    set state(newState) {
        if (this.#state === newState) return;

        eventSource.emit(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, newState)
            .then(() => {
                this.#state = newState;
                eventSource.emit(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, this.state);
            });
    }

    get isLongPress() {
        return this.#longPress;
    }

    set isLongPress(longPress) {
        this.#longPress = longPress;
    }

    get stateChangeCallbacks() {
        return this.#stateChangeCallbacks;
    }

    /**
     * The selected characters among the rows on screen, and the ones picked one by one elsewhere. A selection made
     * with "select all" or a range holds more than this; the bulk actions act on all of it.
     * @returns {string[]}
     */
    get selectedCharacters() {
        const avatars = new Set(this.#selection.include.keys());
        for (const row of this.#getEnabledElements()) {
            const avatar = BulkEditOverlay.#resolveAvatar(row);
            if (isSelected(this.#selection, avatar, BulkEditOverlay.#resolvePosition(row))) avatars.add(avatar);
        }
        return [...avatars];
    }

    /**
     * The instance of the bulk tag popup handler that handles tagging of all selected characters
     *
     * @returns {BulkTagPopupHandler}
     */
    get bulkTagPopupHandler() {
        return this.#bulkTagPopupHandler;
    }

    constructor() {
        if (bulkEditOverlayInstance instanceof BulkEditOverlay)
            return bulkEditOverlayInstance;

        this.container = document.getElementById(BulkEditOverlay.containerId);

        eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, this.handleStateChange);
        bulkEditOverlayInstance = Object.freeze(this);
    }

    /**
     * Set the overlay to browse mode
     */
    browseState = () => this.state = BulkEditOverlayState.browse;

    /**
     * Set the overlay to select mode
     */
    selectState = () => this.state = BulkEditOverlayState.select;

    /**
     * Sets up a newly drawn page. In select mode the selection carries over to it, unless the page belongs to another
     * list (another filter, search or sort), which clears it.
     */
    onPageLoad = () => {
        const elements = this.#getEnabledElements();
        elements.forEach(element => element.addEventListener('touchstart', this.handleHold));
        elements.forEach(element => element.addEventListener('mousedown', this.handleHold));
        elements.forEach(element => element.addEventListener('contextmenu', this.handleDefaultContextMenu));

        elements.forEach(element => element.addEventListener('touchend', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('mouseup', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('dragend', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('touchmove', this.handleLongPressEnd));

        if (this.state !== BulkEditOverlayState.select) return;

        const queryKey = getCharacterListPageContext().queryKey;
        if (queryKey !== this.#selectionQueryKey) {
            setAll(this.#selection, false);
            Object.assign(this.lastSelected, { characterId: undefined, position: undefined, select: undefined });
            this.#selectionQueryKey = queryKey;
        }
        this.#disableClickEventsForCharacters();
        this.#disableClickEventsForGroups();
        this.#paintSelection();
        this.updateSelectedCount();

        // Cohee: It only triggers when clicking on a margin between the elements?
        // Feel free to fix or remove this, I'm not sure how to.
        //this.container.addEventListener('click', this.handleCancelClick);
    };

    /**
     * Handle state changes
     *
     *
     */
    handleStateChange = () => {
        switch (this.state) {
            case BulkEditOverlayState.browse:
                this.container.classList.remove(BulkEditOverlay.selectModeClass);
                this.#contextMenuOpen = false;
                this.#enableClickEventsForCharacters();
                this.#enableClickEventsForGroups();
                this.clearSelectedCharacters();
                this.disableContextMenu();
                this.#disableBulkEditButtonHighlight();
                CharacterContextMenu.hide();
                break;
            case BulkEditOverlayState.select:
                this.container.classList.add(BulkEditOverlay.selectModeClass);
                this.#selectionQueryKey = getCharacterListPageContext().queryKey;
                this.#disableClickEventsForCharacters();
                this.#disableClickEventsForGroups();
                this.enableContextMenu();
                this.#enableBulkEditButtonHighlight();
                break;
        }

        this.stateChangeCallbacks.forEach(callback => callback(this.state));
    };

    /**
     * Block the browsers native context menu and
     * set a click event to hide the custom context menu.
     */
    enableContextMenu = () => {
        this.container.addEventListener('contextmenu', this.handleContextMenuShow);
        document.addEventListener('click', this.handleContextMenuHide);
    };

    /**
     * Remove event listeners, allowing the native browser context
     * menu to be opened.
     */
    disableContextMenu = () => {
        this.container.removeEventListener('contextmenu', this.handleContextMenuShow);
        document.removeEventListener('click', this.handleContextMenuHide);
    };

    handleDefaultContextMenu = (event) => {
        if (this.isLongPress) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    };

    /**
     * Opens menu on long-press.
     *
     * @param event - Pointer event
     */
    handleHold = (event) => {
        if (0 !== event.button && event.type !== 'touchstart') return;
        if (this.#contextMenuOpen) {
            this.#contextMenuOpen = false;
            this.#cancelNextToggle = true;
            CharacterContextMenu.hide();
            return;
        }

        let cancel = false;

        const cancelHold = (event) => cancel = true;
        this.container.addEventListener('mouseup', cancelHold);
        this.container.addEventListener('touchend', cancelHold);

        this.isLongPress = true;

        setTimeout(() => {
            if (this.isLongPress && !cancel) {
                if (this.state === BulkEditOverlayState.browse) {
                    this.selectState();
                } else if (this.state === BulkEditOverlayState.select) {
                    this.#contextMenuOpen = true;
                    const [x, y] = this.#getContextMenuPosition(event);
                    CharacterContextMenu.show(x, y);
                }
            }

            this.container.removeEventListener('mouseup', cancelHold);
            this.container.removeEventListener('touchend', cancelHold);
        }, BulkEditOverlay.longPressDelay);
    };

    handleLongPressEnd = (event) => {
        this.isLongPress = false;
        if (this.#contextMenuOpen) event.stopPropagation();
    };

    handleCancelClick = () => {
        if (false === this.#contextMenuOpen) this.state = BulkEditOverlayState.browse;
        this.#contextMenuOpen = false;
    };

    /**
     * Returns the position of the mouse/touch location
     *
     * @param event
     * @returns {(boolean|number|*)[]}
     */
    #getContextMenuPosition = (event) => [
        event.clientX || event.touches[0].clientX,
        event.clientY || event.touches[0].clientY,
    ];

    #stopEventPropagation = (event) => {
        if (this.#contextMenuOpen) {
            this.handleContextMenuHide(event);
        }
        event.stopPropagation();
    };

    #enableClickEventsForGroups = () => this.#getDisabledElements().forEach((element) => element.removeEventListener('click', this.#stopEventPropagation));

    #disableClickEventsForGroups = () => this.#getDisabledElements().forEach((element) => element.addEventListener('click', this.#stopEventPropagation));

    #enableClickEventsForCharacters = () => this.#getEnabledElements().forEach(element => element.removeEventListener('click', this.toggleCharacterSelected));

    #disableClickEventsForCharacters = () => this.#getEnabledElements().forEach(element => element.addEventListener('click', this.toggleCharacterSelected));

    #enableBulkEditButtonHighlight = () => document.getElementById('bulkEditButton').classList.add('bulk_edit_overlay_active');

    #disableBulkEditButtonHighlight = () => document.getElementById('bulkEditButton').classList.remove('bulk_edit_overlay_active');

    #getEnabledElements = () => [...this.container.getElementsByClassName(BulkEditOverlay.characterClass)];

    #getDisabledElements = () => [...this.container.getElementsByClassName(BulkEditOverlay.groupClass), ...this.container.getElementsByClassName(BulkEditOverlay.bogusFolderClass)];

    /**
     * Resolves the avatar (the stable id this class stores selections by) for a character row element - the
     * only identifier a character row carries.
     * @param {Element} character - The html element of a character row
     * @returns {string} The avatar of the character
     */
    static #resolveAvatar = (character) => character.getAttribute('data-avatar');

    /**
     * A character row's position in the list (`data-list-position`), or NaN when it has none.
     * @param {Element} character
     * @returns {number}
     */
    static #resolvePosition = (character) => Number(character.getAttribute('data-list-position') ?? NaN);

    /**
     * Shows each row on screen as selected or not.
     */
    #paintSelection = () => {
        for (const row of this.#getEnabledElements()) {
            const selected = isSelected(this.#selection, BulkEditOverlay.#resolveAvatar(row), BulkEditOverlay.#resolvePosition(row));
            row.classList.toggle(BulkEditOverlay.selectedClass, selected);
            const checkbox = /** @type {HTMLInputElement|null} */ (row.querySelector('.' + BulkEditOverlay.legacySelectedClass));
            if (checkbox) checkbox.checked = selected;
        }
    };

    toggleCharacterSelected = event => {
        event.stopPropagation();

        const character = event.currentTarget;

        if (!this.#contextMenuOpen && !this.#cancelNextToggle) {
            if (event.shiftKey) {
                // Shift click might have selected text that we don't want to. Unselect it.
                document.getSelection().removeAllRanges();

                this.handleShiftClick(character);
            } else {
                this.toggleSingleCharacter(character);
            }
        }

        this.#cancelNextToggle = false;
    };

    /**
     * When shift click was held down, this function handles the multi select of characters in a single click.
     *
     * If the last clicked character was deselected, and the current one was deselected too, it will deselect every
     * character between those two in the list's order, on this page or not.
     * If the last clicked character was selected, and the current one was selected too, it will select them all.
     * If the states do not match, nothing will happen.
     *
     * @param {HTMLElement} currentCharacter - The html element of the currently toggled character
     */
    handleShiftClick = (currentCharacter) => {
        const select = !isSelected(this.#selection, BulkEditOverlay.#resolveAvatar(currentCharacter), BulkEditOverlay.#resolvePosition(currentCharacter));

        if (this.lastSelected.characterId !== undefined && this.lastSelected.select !== undefined) {
            // Only if select state and the last select state match we execute the range select
            if (select === this.lastSelected.select) {
                this.toggleCharactersInRange(currentCharacter, select);
            }
        }
    };

    /**
     * Toggles the selection of a given characters
     *
     * @param {HTMLElement} character - The html element of a character
     * @param {object} param1 - Optional params
     * @param {boolean} [param1.markState] - Whether the toggle of this character should be remembered as the last done toggle
     */
    toggleSingleCharacter = (character, { markState = true } = {}) => {
        const characterId = BulkEditOverlay.#resolveAvatar(character);
        const position = BulkEditOverlay.#resolvePosition(character);

        const select = !isSelected(this.#selection, characterId, position);
        setOne(this.#selection, characterId, position, select);

        character.classList.toggle(BulkEditOverlay.selectedClass, select);
        const legacyBulkEditCheckbox = /** @type {HTMLInputElement} */ (character.querySelector('.' + BulkEditOverlay.legacySelectedClass));
        if (legacyBulkEditCheckbox) legacyBulkEditCheckbox.checked = select;

        this.updateSelectedCount();

        if (markState) {
            Object.assign(this.lastSelected, { characterId, position, select });
        }
    };

    /**
     * Selects every character the list shows, or, when that is already the selection, nothing.
     */
    toggleSelectAll = () => {
        setAll(this.#selection, !isEverything(this.#selection));
        Object.assign(this.lastSelected, { characterId: undefined, position: undefined, select: undefined });
        this.#paintSelection();
        this.updateSelectedCount();
    };

    /**
     * Updates the selected count element with the current count. A count involving "select all" or a range is an
     * estimate (`~`) until an action asks the server, which counts it exactly.
     *
     * @param {number} [countOverride] - optional override for a manual number to set
     */
    updateSelectedCount = (countOverride = undefined) => {
        const context = getCharacterListPageContext();
        const { count, approx } = countOverride !== undefined
            ? { count: countOverride, approx: false }
            : countSelection(this.#selection, context.total);
        const text = `${approx ? '~' : ''}${count}`;
        $(`#${BulkEditOverlay.bulkSelectedCountId}`).text(text).attr('title', t`${text} characters selected`);
    };

    /**
     * Toggles the selection of characters in a given range: every row of the list between the given character and
     * the last selected one, in the list's order, whether drawn on this page or not.
     *
     * @param {HTMLElement} currentCharacter - The html element of the currently toggled character
     * @param {boolean} select - <c>true</c> if the characters in the range are to be selected, <c>false</c> if deselected
     */
    toggleCharactersInRange = (currentCharacter, select) => {
        const characterId = BulkEditOverlay.#resolveAvatar(currentCharacter);
        const position = BulkEditOverlay.#resolvePosition(currentCharacter);
        const lastPosition = this.lastSelected.position;
        if (!Number.isInteger(position) || !Number.isInteger(lastPosition)) {
            this.toggleSingleCharacter(currentCharacter);
            return;
        }

        setRange(this.#selection, lastPosition, position, select);
        Object.assign(this.lastSelected, { characterId, position, select });
        this.#paintSelection();
        this.updateSelectedCount();
    };

    handleContextMenuShow = (event) => {
        event.preventDefault();
        const [x, y] = this.#getContextMenuPosition(event);
        CharacterContextMenu.show(x, y);
        this.#contextMenuOpen = true;
    };

    handleContextMenuHide = (event) => {
        let contextMenu = document.getElementById(BulkEditOverlay.contextMenuId);
        if (false === contextMenu.contains(event.target)) {
            CharacterContextMenu.hide();
            this.#contextMenuOpen = false;
        }
    };

    /**
     * Has the server fix the selection as a job, and hands it to `use`; the job is dropped afterwards unless `use`
     * says it keeps it (returns true).
     * @param {(prepared: PreparedSelection) => Promise<boolean|void>} use
     */
    #withPrepared = async (use) => {
        if (isEmpty(this.#selection)) {
            toastr.info(t`No characters are selected.`, t`Bulk edit`);
            return;
        }
        const reading = loader.show({ slug: 'bulk-prepare', title: t`Bulk edit`, message: t`Reading the selection…`, toastMode: loader.ToastMode.STATIC });
        let prepared;
        try {
            prepared = await prepareSelection(selectionToWire(this.#selection, getCharacterListPageContext().query));
        } finally {
            await reading.hide();
        }
        if (!prepared) return;
        let kept = false;
        try {
            if (prepared.count === 0) {
                toastr.info(t`None of the selected characters exist any more.`, t`Bulk edit`);
                return;
            }
            kept = (await use(prepared)) === true;
        } finally {
            if (!kept) dropPrepared(prepared.job);
        }
    };

    /**
     * Toggles the favorite status of every selected character, on the server.
     *
     * @returns {Promise<void>}
     */
    handleContextMenuFavorite = async () => {
        await this.#withPrepared(async (prepared) => {
            const result = await runPrepared(prepared, 'fav', {}, t`Favorite`, line => CharacterContextMenu.applyFav(line.avatar, line.fav));
            reportBulkProblems(t`Favorite`, result);
            await eventSource.emit(event_types.CHARACTERS_BULK_EDITED, { action: 'fav', done: result.done, failed: result.failed.length });
        });
        await getCharacters({ keepListPosition: true });
        await favsToHotswap();
        this.browseState();
    };

    /**
     * Duplicates every selected character, on the server.
     *
     * @returns {Promise<void>}
     */
    handleContextMenuDuplicate = async () => {
        await this.#withPrepared(async (prepared) => {
            const held = new Set(charactersStore.getAll().map(character => character.avatar));
            const result = await runPrepared(prepared, 'duplicate', {}, t`Duplicate`, async (line) => {
                // Extensions see the characters the page holds; the rest are counted in CHARACTERS_BULK_EDITED.
                if (held.has(line.avatar)) await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: line.avatar, newAvatar: line.path });
            });
            reportBulkProblems(t`Duplicate`, result);
            await eventSource.emit(event_types.CHARACTERS_BULK_EDITED, { action: 'duplicate', done: result.done, failed: result.failed.length });
        });
        await getCharacters({ keepListPosition: true });
        this.browseState();
    };

    /**
     * Converts every selected character to a persona. It asks only about a character whose persona already exists,
     * or whose description uses macros, when that character comes up.
     *
     * @returns {Promise<void>}
     */
    handleContextMenuPersona = async () => {
        await this.#withPrepared(async (prepared) => {
            const progress = progressToast(t`Convert to persona`, prepared.count);
            let result;
            try {
                result = await convertCharactersToPersonas(preparedAvatars(prepared.job), done => progress.update(done));
            } catch (error) {
                console.error('Bulk persona conversion failed:', error);
                toastr.error(t`It stopped before the end. The characters it hadn't reached yet were not converted.`, t`Convert to persona`);
                return;
            } finally {
                progress.close();
            }
            if (result.converted > 0) {
                toastr.success(t`${result.converted} persona(s) created. You can pick them in the Persona Management menu.`, t`Convert to persona`);
            }
            if (result.failed.length > 0) {
                toastr.error(t`These characters were not converted:` + `<br />${result.failed.map(escapeHtml).join('<br />')}`, t`Convert to persona`, { escapeHtml: false, timeOut: 0, extendedTimeOut: 0 });
            }
            if (result.cancelled) {
                toastr.info(t`Cancelled. The characters after that one were not converted.`, t`Convert to persona`);
            }
        });

        this.browseState();
    };

    /**
     * Gets the HTML as a string that is displayed inside the popup for the bulk delete
     *
     * @param {Array<string>|number} characterIds - The characters that are shown inside the popup, or how many there are
     * @returns String containing the html for the popup content
     */
    static #getDeletePopupContentHtml = (characterIds) => {
        const count = Array.isArray(characterIds) ? characterIds.length : characterIds;
        return `
            <h3 class="marginBot5">${escapeHtml(t`Delete ${count} characters?`)}</h3>
            <span class="bulk_delete_note">
                <i class="fa-solid fa-triangle-exclamation warning margin-r5"></i>
                <b>THIS IS PERMANENT!</b>
            </span>
            <div id="bulk_delete_avatars_block" class="avatars_inline avatars_inline_small tags tags_inline m-t-1"></div>
            <br>
            <div id="bulk_delete_options" class="m-b-1">
                <label for="del_char_checkbox" class="checkbox_label justifyCenter">
                    <input type="checkbox" id="del_char_checkbox" />
                    <span>Also delete the chat files</span>
                </label>
            </div>`;
    };

    /**
     * Asks, showing exactly how many characters will go, then deletes every selected character on the server.
     *
     * @returns {Promise<void>}
     */
    handleContextMenuDelete = async () => {
        await this.#withPrepared(async (prepared) => {
            const popupContent = $(BulkEditOverlay.#getDeletePopupContentHtml(prepared.count));
            const checkbox = popupContent.find('#del_char_checkbox');
            const confirmed = callGenericPopup(popupContent, POPUP_TYPE.CONFIRM);

            // The popup is in the DOM but not resolved yet; fill its avatar list once the first characters are read.
            import('./character-repository.js')
                .then(({ characterRepository }) => characterRepository.getMany(prepared.sample))
                .then((resolved) => {
                    const entities = prepared.sample.filter(avatar => resolved.has(avatar)).map(avatar => characterToEntity(resolved.get(avatar)));
                    buildAvatarList($('#bulk_delete_avatars_block'), entities);
                    if (prepared.count > entities.length) {
                        $('#bulk_delete_avatars_block').append($('<div class="bulk_more_note"></div>').text(t`and ${prepared.count - entities.length} more`));
                    }
                })
                .catch(error => console.error('Could not read the characters selected for deletion:', error));

            if (!await confirmed) return;
            const deleteChats = checkbox.prop('checked') ?? false;

            if (prepared.containsCurrent && !await closeCurrentChat()) return;

            // Extensions see the characters the page holds: they get CHARACTER_DELETED (and CHAT_DELETED), with the
            // character, as a single delete gives them. The rest are counted in CHARACTERS_BULK_EDITED.
            const held = new Map(charactersStore.getAll().map(character => [character.avatar, character]));
            /** @type {Map<string, any[]>} */
            const pastChats = new Map();
            if (deleteChats) {
                for (const avatar of held.keys()) {
                    pastChats.set(avatar, await getPastCharacterChats(avatar));
                }
            }

            /** @type {{avatar: string, entity: object}[]} */
            const removedHeld = [];
            /** @type {string[]} */
            const removedRows = [];
            const result = await runPrepared(prepared, 'delete', { deleteChats }, t`Bulk Delete`, async (line) => {
                removedRows.push(line.avatar);
                const character = held.get(line.avatar);
                if (!character) return;
                accountStorage.removeItem(`AlertRegex_${character.avatar}`);
                accountStorage.removeItem(`mediaWarningShown:${character.avatar}`);
                removeEntityTags(character.avatar);
                for (const chat of pastChats.get(character.avatar) ?? []) {
                    await eventSource.emit(event_types.CHAT_DELETED, chat.file_name.replace('.jsonl', ''));
                }
                await eventSource.emit(event_types.CHARACTER_DELETED, { id: undefined, character });
                removedHeld.push({ avatar: character.avatar, entity: character });
            });

            if (prepared.containsCurrent) {
                await removeCharacterFromUI(removedHeld);
            } else {
                for (const { avatar, entity } of removedHeld) charactersStore.reportRemoved(avatar, entity);
                await getCharacters({ keepListPosition: true });
            }
            for (const avatar of removedRows) removeCharacterListRow(avatar);

            reportBulkProblems(t`Bulk Delete`, result);
            if (result.done > 0) toastr.success(t`${result.done} character(s) deleted.`, t`Bulk Delete`);
            await eventSource.emit(event_types.CHARACTERS_BULK_EDITED, { action: 'delete', done: result.done, failed: result.failed.length });
            forgetDeletedCharactersInBrowser().catch(error => console.warn('Could not forget deleted characters in the browser:', error));
        });

        this.browseState();
    };

    /**
     * Attaches and opens the tag menu for every selected character.
     */
    handleContextMenuTag = async () => {
        await this.#withPrepared(async (prepared) => {
            await this.#bulkTagPopupHandler.showPrepared(prepared);
            // The popup owns the job now and drops it when it closes.
            return true;
        });
        this.browseState();
    };

    addStateChangeCallback = callback => this.stateChangeCallbacks.push(callback);

    /**
     * Clears the selection and removes visual highlight.
     */
    clearSelectedCharacters = () => {
        setAll(this.#selection, false);
        Object.assign(this.lastSelected, { characterId: undefined, position: undefined, select: undefined });
        document.querySelectorAll('#' + BulkEditOverlay.containerId + ' .' + BulkEditOverlay.selectedClass)
            .forEach(element => element.classList.remove(BulkEditOverlay.selectedClass));
    };
}

export { BulkEditOverlayState, CharacterContextMenu, BulkEditOverlay };
