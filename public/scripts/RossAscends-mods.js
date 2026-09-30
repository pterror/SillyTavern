import { handleFieldEditKey } from './character-field-editor.js';
import { DOMPurify, Bowser } from '../lib.js';

import {
    online_status,
    is_send_press,
    saveSettingsDebounced,
    buildAvatarList,
    selectCharacterByAvatar,
    menu_type,
    substituteParams,
    requestTextareaSend,
    doNavbarIconClick,
    frontDrawer,
    keepOneRightPanelOpen,
    readSavedPanelOpenStates,
    isSwipingAllowed,
} from '../script.js';
import { queryWithSortFallback, characterToEntity, groupToEntity, entitiesFilter } from './character-list.js';
import { active_character, active_group, setActiveCharacter, setActiveGroup } from './app-selection-state.js';
import { main_api, max_context } from './generation-params.js';
import { getRequestHeaders } from './request-headers.js';
import { charactersStore } from './character-store.js';
import { eventSource } from './events.js';

import {
    power_user,
    send_on_enter_options,
} from './power-user.js';

import { characterRepository, buildCharacterQuery, normalizeQueryRow } from './character-repository.js';
import { getRandomSortSeed } from './random-sort.js';
import { selected_group, is_group_generating, openGroupById } from './group-chats.js';
import { applyTagsOnCharacterSelect } from './tags.js';
import { tagFetchStamp, isFetchedTagIdsCurrent } from './tag-fetch-stamps.js';
import {
    SECRET_KEYS,
    secret_state,
} from './secrets.js';
import { debounce, getStringHash, isValidUrl } from './utils.js';
import { chat_completion_sources, oai_settings, POLLINATIONS_ENDPOINT } from './chat-completion-settings.js';
import { getRememberedTokenizerAnswer, getTokenCountsWithTokenizer } from './tokenizers.js';
import { renderCountBasis } from './tokenizer-notices.js';
import { textgen_types, textgenerationwebui_settings as textgen_settings, getTextGenServer } from './textgen-settings.js';
import { debounce_timeout, SWIPE_SOURCE } from './constants.js';

import { Popup } from './popup.js';
import { accountStorage } from './util/AccountStorage.js';
import { getCurrentUserHandle } from './user.js';
import { kai_settings } from './kai-settings.js';

var RPanelPin = document.getElementById('rm_button_panel_pin');
var LPanelPin = document.getElementById('lm_button_panel_pin');
var WIPanelPin = document.getElementById('WI_panel_pin');
var CharInfoPanelPin = document.getElementById('charInfo_button_panel_pin');

var RightNavPanel = document.getElementById('right-nav-panel');
var RightNavDrawerIcon = document.getElementById('rightNavDrawerIcon');
var LeftNavPanel = document.getElementById('left-nav-panel');
var LeftNavDrawerIcon = document.getElementById('leftNavDrawerIcon');
var WorldInfo = document.getElementById('WorldInfo');
var WIDrawerIcon = document.getElementById('WIDrawerIcon');
var CharInfoPanel = document.getElementById('char-info-panel');
var CharInfoDrawerIcon = document.getElementById('charInfoDrawerIcon');

var SelectedCharacterTab = document.getElementById('rm_button_selected_ch');

var connection_made = false;
var retry_delay = 500;
let counterNonce = Date.now();
// Set when an internal count trigger fired while the character editor wasn't showing; the count runs when it shows.
let editorCountPending = false;

const observerConfig = { childList: true, subtree: true };
const countTokensDebounced = debounce(RA_CountCharTokens, debounce_timeout.relaxed);
const countTokensWhenShownDebounced = debounce(countCharTokensIfShown, debounce_timeout.relaxed);
const countTokensWhenShownSoonDebounced = debounce(countCharTokensIfShown, debounce_timeout.short);
const checkStatusDebounced = debounce(RA_checkOnlineStatus, debounce_timeout.short);

const observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
        if (!(mutation.target instanceof HTMLElement)) {
            return;
        }
        if (mutation.target.classList.contains('online_status_text')) {
            checkStatusDebounced();
        } else if (mutation.target.parentNode === SelectedCharacterTab) {
            countCharTokensWhenShownSoon();
        } else if (mutation.target.classList.contains('mes_text')) {
            for (const element of mutation.target.getElementsByTagName('math')) {
                element.childNodes.forEach(function (child) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        child.textContent = '';
                    }
                });
            }
        }
    });
});

observer.observe(document.documentElement, observerConfig);

// Crossing the mobile breakpoint can uncover the editor with no drawer change.
window.matchMedia('screen and (max-width: 1000px)').addEventListener('change', onCharacterEditorMaybeShown);


/**
 * Converts generation time from milliseconds to a human-readable format.
 *
 * The function takes total generation time as an input, then converts it to a format
 * of "_ Days, _ Hours, _ Minutes, _ Seconds". If the generation time does not exceed a
 * particular measure (like days or hours), that measure will not be included in the output.
 *
 * @param {number} total_gen_time - The total generation time in milliseconds.
 * @returns {string} - A human-readable string that represents the time spent generating characters.
 */
export function humanizeGenTime(total_gen_time) {
    //convert time_spent to humanized format of "_ Hours, _ Minutes, _ Seconds" from milliseconds
    let time_spent = total_gen_time || 0;
    time_spent = Math.floor(time_spent / 1000);
    let seconds = time_spent % 60;
    time_spent = Math.floor(time_spent / 60);
    let minutes = time_spent % 60;
    time_spent = Math.floor(time_spent / 60);
    let hours = time_spent % 24;
    time_spent = Math.floor(time_spent / 24);
    let days = time_spent;
    let result = '';
    if (days > 0) { result += `${days} Days, `; }
    if (hours > 0) { result += `${hours} Hours, `; }
    if (minutes > 0) { result += `${minutes} Minutes, `; }
    result += `${seconds} Seconds`;
    return result;
}

// Keep as `var` - do not change to const/let
var parsedUA = null;

export function getParsedUA() {
    if (!parsedUA) {
        try {
            parsedUA = Bowser.parse(navigator.userAgent);
        } catch {
            // In case the user agent is an empty string or Bowser can't parse it for some other reason
        }
    }

    return parsedUA;
}

export function isMobile() {
    const mobileTypes = ['mobile', 'tablet'];

    return mobileTypes.includes(getParsedUA()?.platform?.type);
}

export function shouldSendOnEnter() {
    if (!power_user) {
        return false;
    }

    switch (power_user.send_on_enter) {
        case send_on_enter_options.DISABLED:
            return false;
        case send_on_enter_options.AUTO:
            return !isMobile();
        case send_on_enter_options.ENABLED:
            return true;
    }
}

// Format: YYYY-MM-DD@HHhMMmSSsMSms
export function humanizedDateTime(timestamp = Date.now()) {
    const date = new Date(timestamp);
    const dt = {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        second: date.getSeconds(),
        millisecond: date.getMilliseconds(),
    };
    for (const key in dt) {
        const padLength = key === 'millisecond' ? 3 : 2;
        dt[key] = dt[key].toString().padStart(padLength, '0');
    }
    return `${dt.year}-${dt.month}-${dt.day}@${dt.hour}h${dt.minute}m${dt.second}s${dt.millisecond}ms`;
}

export function getMessageTimeStamp(timestamp = Date.now()) {
    const date = new Date(timestamp);
    return date.toISOString();
}


// triggers:
$('#rm_button_create').on('click', function () {                 //when "+New Character" is clicked
    $(SelectedCharacterTab).children('h2').html('');        // empty nav's 3rd panel tab
});
//when any input is made to the create/edit character form textareas
$('#rm_ch_create_block').on('input', function () { countTokensDebounced(); });
/**
 * Whether the character editor is on screen: #char-info-panel open, not covered by another drawer
 * (covered drawers are hidden by visibility), and showing the editor rather than the group panel.
 * @returns {boolean}
 */
export function isCharacterEditorShowing() {
    const panel = document.getElementById('char-info-panel');
    return Boolean(panel?.classList.contains('openDrawer'))
        && getComputedStyle(panel).visibility !== 'hidden'
        && panel.getAttribute('data-active-menu') === 'rm_ch_create_block';
}

function countCharTokensIfShown() {
    if (!isCharacterEditorShowing()) {
        editorCountPending = true;
        return;
    }
    RA_CountCharTokens();
}

/**
 * Counts the character editor's tokens after the usual 1000 ms debounce, or, if the editor isn't showing
 * then, when it next shows. For internal triggers; RA_CountCharTokens() counts right away.
 */
export function countCharTokensWhenShown() {
    countTokensWhenShownDebounced();
}

/** Same as countCharTokensWhenShown(), with a 200 ms debounce. */
export function countCharTokensWhenShownSoon() {
    countTokensWhenShownSoonDebounced();
}

/**
 * Runs a count held back while the character editor was hidden, if it is showing now.
 * Called from every place that can make the editor visible.
 */
export function onCharacterEditorMaybeShown() {
    if (editorCountPending && isCharacterEditorShowing()) {
        RA_CountCharTokens();
    }
}

export async function RA_CountCharTokens() {
    editorCountPending = false;
    counterNonce = Date.now();
    const counterNonceLocal = counterNonce;
    let total_tokens = 0;
    let permanent_tokens = 0;
    // The answer the total is rendered with: the batch's, when there is one.
    let totalAnswer = getRememberedTokenizerAnswer();

    const tokenCounters = document.querySelectorAll('[data-token-counter]');

    // First pass: resolve everything already cached (or empty) synchronously, and collect
    // the distinct uncached values that actually need a token count. Every network-bound
    // field is queued here and sent as ONE batched request below, instead of one request
    // per counter.
    const pending = [];
    for (const tokenCounter of tokenCounters) {
        const counter = $(tokenCounter);
        const input = $(document.getElementById(counter.data('token-counter')));
        const isPermanent = counter.data('token-permanent') === true;
        const value = String(input.val());

        if (input.length === 0) {
            counter.text('Invalid input reference');
            continue;
        }

        if (!value) {
            input.data('last-value-hash', '');
            counter.text(0);
            renderCountBasis(counter, getRememberedTokenizerAnswer());
            counter.closest('.inline-drawer').toggleClass('token-count-zero', true);
            counter.closest('small').toggle(false);
            continue;
        }

        const valueHash = getStringHash(value);

        if (input.data('last-value-hash') === valueHash) {
            total_tokens += Number(counter.text());
            permanent_tokens += isPermanent ? Number(counter.text()) : 0;
        } else {
            const valueToCount = menu_type === 'create' ? value : substituteParams(value);
            pending.push({ counter, input, isPermanent, valueHash, valueToCount });
        }
    }

    if (pending.length > 0) {
        const { counts: counted, answer } = await getTokenCountsWithTokenizer(pending.map(p => p.valueToCount));
        totalAnswer = answer;

        if (counterNonceLocal !== counterNonce) {
            return;
        }

        pending.forEach((p, i) => {
            const tokens = counted[i];
            p.counter.text(tokens);
            renderCountBasis(p.counter, answer);
            p.counter.closest('.inline-drawer').toggleClass('token-count-zero', tokens === 0);
            p.counter.closest('small').toggle(tokens !== 0);
            total_tokens += tokens;
            permanent_tokens += p.isPermanent ? tokens : 0;
            p.input.data('last-value-hash', p.valueHash);
        });
    }

    const tokenLimit = Math.max(((main_api !== 'openai' ? max_context : oai_settings.openai_max_context) / 2), 1024);
    const showWarning = (total_tokens > tokenLimit);
    $('#result_info_total_tokens').text(total_tokens);
    renderCountBasis($('#result_info_total_tokens'), totalAnswer);
    $('#result_info_permanent_tokens').text(permanent_tokens);
    $('#result_info_text').toggleClass('neutral_warning', showWarning);
    $('#chartokenwarning').toggle(showWarning);
}
// Auto-loads the last active character or group, if any.
async function RA_autoloadchat() {
    if (active_character !== null && active_character !== undefined) {
        // active_character is the character's avatar filename
        let activeCharacterEntity = charactersStore.get(active_character);

        // Not resident yet (background library load may still be in progress) - fetch this one
        // character directly instead of waiting for the full list.
        if (!activeCharacterEntity) {
            try {
                const fetchStamp = tagFetchStamp();
                const resp = await fetch('/api/characters/get', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: active_character }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    data.shallow = false;
                    if (!isFetchedTagIdsCurrent(active_character, fetchStamp)) {
                        delete data.tag_ids;
                    }
                    if (!charactersStore.has(active_character)) {
                        charactersStore.create(data);
                    } else {
                        charactersStore.update(active_character, data);
                    }
                    activeCharacterEntity = charactersStore.get(active_character);
                }
            } catch (err) {
                console.error('[RA_autoloadchat] Failed to fetch active character directly:', err);
            }
        }

        if (activeCharacterEntity) {
            await selectCharacterByAvatar(activeCharacterEntity.avatar);
            applyTagsOnCharacterSelect();
        } else {
            setActiveCharacter(null);
            saveSettingsDebounced('active_character', 'active_group');
            console.warn(`Currently active character with ID ${active_character} not found. Resetting to no active character.`);
        }
    }

    if (active_group !== null && active_group !== undefined) {
        if (active_character) {
            console.warn('Active character and active group are both set. Only active character will be loaded. Resetting active group.');
            setActiveGroup(null);
            saveSettingsDebounced('active_character', 'active_group');
        } else {
            const result = await openGroupById(String(active_group));
            if (!result) {
                setActiveGroup(null);
                saveSettingsDebounced('active_character', 'active_group');
                console.warn(`Currently active group with ID ${active_group} not found. Resetting to no active group.`);
            }
        }
    }
}

/**
 * Fills the favorites hotswap strip with the top FAVS_LIMIT favorited characters and groups, in the list's sort (or
 * its fallback, see queryWithSortFallback()).
 */
export async function favsToHotswap() {
    // The refresh is decorative and most callers don't await/catch it, so an uncaught throw here becomes
    // an unhandled rejection instead of being anyone's problem - swallow and just log it.
    try {
        return await favsToHotswapImpl();
    } catch (error) {
        console.warn('[favsToHotswap] Could not refresh the hotswap row:', error);
    }
}

async function favsToHotswapImpl() {
    const container = $('#right-nav-panel .hotswap');

    // All hotswap images load regardless of whether they fit the screen, so a cap keeps unseen favorites
    // from loading; 25 roughly fits an ultrawide monitor with the default theme.
    const FAVS_LIMIT = 25;

    const isRandom = power_user.sort_order === 'random';
    const sortField = isRandom ? 'random' : power_user.sort_field;
    // Dynamic import (not static): this module sits on an import cycle through power-user.js/script.js, and a
    // static import of filters.js here would reorder that cycle and reproduce a FILTER_TYPES TDZ crash.
    const { FILTER_TYPES } = await import('./filters.js');
    const searchTerm = entitiesFilter.getFilterData(FILTER_TYPES.SEARCH) || '';

    const { filter, sort } = buildCharacterQuery({
        fav: true,
        includeGroups: true,
        searchTerm,
        sortField,
        sortOrder: power_user.sort_order === 'desc' ? 'desc' : 'asc',
        randomSeed: isRandom ? getRandomSortSeed(accountStorage) : undefined,
    });
    const { result } = await queryWithSortFallback(filter, sort,
        trySort => characterRepository.query(filter, trySort, 1, FAVS_LIMIT, ['rows']));
    const favs = (result.rows ?? []).map(row => {
        const { type, item } = normalizeQueryRow(row);
        return type === 'group' ? groupToEntity(item) : characterToEntity(item);
    });

    if (favs.length == 0) {
        container.html(`<small><span><i class="fa-solid fa-star"></i>&nbsp;${DOMPurify.sanitize(container.attr('no_favs'))}</span></small>`);
        return;
    }

    buildAvatarList(container, favs, { interactable: true, highlightFavs: false });
}

//changes input bar and send button display depending on connection status
function RA_checkOnlineStatus() {
    if (online_status == 'no_connection') {
        const send_textarea = $('#send_textarea');
        send_textarea.attr('placeholder', send_textarea.attr('no_connection_text'));
        $('#send_form').addClass('no-connection');
        $('#send_but').addClass('displayNone');
        $('#mes_continue').addClass('displayNone');
        $('#mes_impersonate').addClass('displayNone');
        $('#API-status-top').removeClass('fa-plug');
        $('#API-status-top').addClass('fa-plug-circle-exclamation redOverlayGlow');
        connection_made = false;
    } else {
        if (online_status !== undefined && online_status !== 'no_connection') {
            const send_textarea = $('#send_textarea');
            send_textarea.attr('placeholder', send_textarea.attr('connected_text'));
            $('#send_form').removeClass('no-connection');
            $('#API-status-top').removeClass('fa-plug-circle-exclamation redOverlayGlow');
            $('#API-status-top').addClass('fa-plug');
            connection_made = true;
            retry_delay = 100;

            if (!is_send_press && !(selected_group && is_group_generating)) {
                $('#send_but').removeClass('displayNone');
                $('#mes_continue').removeClass('displayNone');
                $('#mes_impersonate').removeClass('displayNone');
            }
        }
    }
}
//Auto-connect to API (when set to kobold, API URL exists, and auto_connect is true)

function RA_autoconnect(PrevApi) {
    // secrets.js or script.js not loaded
    if (SECRET_KEYS === undefined || online_status === undefined) {
        setTimeout(RA_autoconnect, 100);
        return;
    }
    if (online_status === 'no_connection' && power_user.auto_connect) {
        switch (main_api) {
            case 'kobold':
                if (kai_settings.api_server && isValidUrl(kai_settings.api_server)) {
                    $('#api_button').trigger('click');
                }
                break;
            case 'novel':
                if (secret_state[SECRET_KEYS.NOVEL]) {
                    $('#api_button_novel').trigger('click');
                }
                break;
            case 'textgenerationwebui':
                if ((textgen_settings.type === textgen_types.MANCER && secret_state[SECRET_KEYS.MANCER])
                    || (textgen_settings.type === textgen_types.TOGETHERAI && secret_state[SECRET_KEYS.TOGETHERAI])
                    || (textgen_settings.type === textgen_types.INFERMATICAI && secret_state[SECRET_KEYS.INFERMATICAI])
                    || (textgen_settings.type === textgen_types.DREAMGEN && secret_state[SECRET_KEYS.DREAMGEN])
                    || (textgen_settings.type === textgen_types.OPENROUTER && secret_state[SECRET_KEYS.OPENROUTER])
                    || (textgen_settings.type === textgen_types.FEATHERLESS && secret_state[SECRET_KEYS.FEATHERLESS])
                ) {
                    $('#api_button_textgenerationwebui').trigger('click');
                } else if (isValidUrl(getTextGenServer())) {
                    $('#api_button_textgenerationwebui').trigger('click');
                }
                break;
            case 'openai':
                if (((secret_state[SECRET_KEYS.OPENAI] || oai_settings.reverse_proxy) && oai_settings.chat_completion_source == chat_completion_sources.OPENAI)
                    || ((secret_state[SECRET_KEYS.CLAUDE] || oai_settings.reverse_proxy) && oai_settings.chat_completion_source == chat_completion_sources.CLAUDE)
                    || (secret_state[SECRET_KEYS.OPENROUTER] && oai_settings.chat_completion_source == chat_completion_sources.OPENROUTER)
                    || (secret_state[SECRET_KEYS.AI21] && oai_settings.chat_completion_source == chat_completion_sources.AI21)
                    || (secret_state[SECRET_KEYS.MAKERSUITE] && oai_settings.chat_completion_source == chat_completion_sources.MAKERSUITE)
                    || (secret_state[SECRET_KEYS.VERTEXAI] && oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI && oai_settings.vertexai_auth_mode === 'express')
                    || (secret_state[SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT] && oai_settings.chat_completion_source == chat_completion_sources.VERTEXAI && oai_settings.vertexai_auth_mode === 'full')
                    || (secret_state[SECRET_KEYS.MISTRALAI] && oai_settings.chat_completion_source == chat_completion_sources.MISTRALAI)
                    || (secret_state[SECRET_KEYS.COHERE] && oai_settings.chat_completion_source == chat_completion_sources.COHERE)
                    || (secret_state[SECRET_KEYS.PERPLEXITY] && oai_settings.chat_completion_source == chat_completion_sources.PERPLEXITY)
                    || (secret_state[SECRET_KEYS.GROQ] && oai_settings.chat_completion_source == chat_completion_sources.GROQ)
                    || (secret_state[SECRET_KEYS.CHUTES] && oai_settings.chat_completion_source == chat_completion_sources.CHUTES)
                    || (secret_state[SECRET_KEYS.SILICONFLOW] && oai_settings.chat_completion_source == chat_completion_sources.SILICONFLOW)
                    || (secret_state[SECRET_KEYS.ELECTRONHUB] && oai_settings.chat_completion_source == chat_completion_sources.ELECTRONHUB)
                    || (secret_state[SECRET_KEYS.NANOGPT] && oai_settings.chat_completion_source == chat_completion_sources.NANOGPT)
                    || (secret_state[SECRET_KEYS.DEEPSEEK] && oai_settings.chat_completion_source == chat_completion_sources.DEEPSEEK)
                    || (secret_state[SECRET_KEYS.XAI] && oai_settings.chat_completion_source == chat_completion_sources.XAI)
                    || (secret_state[SECRET_KEYS.AIMLAPI] && oai_settings.chat_completion_source == chat_completion_sources.AIMLAPI)
                    || (secret_state[SECRET_KEYS.MOONSHOT] && oai_settings.chat_completion_source == chat_completion_sources.MOONSHOT)
                    || (secret_state[SECRET_KEYS.FIREWORKS] && oai_settings.chat_completion_source == chat_completion_sources.FIREWORKS)
                    || (secret_state[SECRET_KEYS.COMETAPI] && oai_settings.chat_completion_source == chat_completion_sources.COMETAPI)
                    || (secret_state[SECRET_KEYS.ZAI] && oai_settings.chat_completion_source == chat_completion_sources.ZAI)
                    || ((secret_state[SECRET_KEYS.POLLINATIONS] || oai_settings.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS) && oai_settings.chat_completion_source === chat_completion_sources.POLLINATIONS)
                    || (secret_state[SECRET_KEYS.WORKERS_AI] && oai_settings.chat_completion_source == chat_completion_sources.WORKERS_AI)
                    || (secret_state[SECRET_KEYS.MINIMAX] && oai_settings.chat_completion_source == chat_completion_sources.MINIMAX)
                    || (isValidUrl(oai_settings.custom_url) && oai_settings.chat_completion_source == chat_completion_sources.CUSTOM)
                    || (secret_state[SECRET_KEYS.AZURE_OPENAI] && oai_settings.chat_completion_source == chat_completion_sources.AZURE_OPENAI)
                ) {
                    $('#api_button_openai').trigger('click');
                }
                break;
        }

        if (!connection_made) {
            retry_delay = Math.min(retry_delay * 2, 30000); // double retry delay up to to 30 secs
            // console.log('connection attempts: ' + RA_AC_retries + ' delay: ' + (retry_delay / 1000) + 's');
            // setTimeout(RA_autoconnect, retry_delay);
        }
    }
}

const getUserInputKey = () => getCurrentUserHandle() + '_userInput';

function restoreUserInput() {
    if (!power_user.restore_user_input) {
        console.debug('restoreUserInput disabled');
        return;
    }

    const userInput = localStorage.getItem(getUserInputKey());
    if (userInput) {
        $('#send_textarea').val(userInput)[0].dispatchEvent(new Event('input', { bubbles: true }));
    }
}

function saveUserInput() {
    const userInput = String($('#send_textarea').val());
    localStorage.setItem(getUserInputKey(), userInput);
}
const saveUserInputDebounced = debounce(saveUserInput);

export function dragElement($elmnt) {
    let actionType = null; // "drag" or "resize"
    let isMouseDown = false;

    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    let height, width, top, left, right, bottom,
        maxX, maxY, winHeight, winWidth;

    const elmntName = $elmnt.attr('id');
    const elmntNameEscaped = $.escapeSelector(elmntName);
    const $elmntHeader = $(`#${elmntNameEscaped}header`);

    // Helper: Save position/size to state and emit events
    function savePositionAndSize() {
        if (!power_user.movingUIState[elmntName]) power_user.movingUIState[elmntName] = {};
        power_user.movingUIState[elmntName].top = top;
        power_user.movingUIState[elmntName].left = left;
        power_user.movingUIState[elmntName].right = right;
        power_user.movingUIState[elmntName].bottom = bottom;
        power_user.movingUIState[elmntName].margin = 'unset';
        if (actionType === 'resize') {
            power_user.movingUIState[elmntName].width = width;
            power_user.movingUIState[elmntName].height = height;
            eventSource.emit('resizeUI', elmntName);
        }
        saveSettingsDebounced('power_user.movingUIState');
    }

    // Helper: Clamp element within viewport
    function clampToViewport() {
        if (top <= 0) $elmnt.css('top', '0px');
        else if (maxY >= winHeight) $elmnt.css('top', winHeight - maxY + top - 1 + 'px');
        if (left <= 0) $elmnt.css('left', '0px');
        else if (maxX >= winWidth) $elmnt.css('left', winWidth - maxX + left - 1 + 'px');
    }

    const observer = new MutationObserver((mutations) => {
        const $target = $(mutations[0].target);
        if (
            !$target.is(':visible') ||
            $target.hasClass('resizing') ||
            $target.height() < 50 ||
            $target.width() < 50 ||
            power_user.movingUI === false ||
            isMobile() ||
            !isMouseDown
        ) {
            observer.disconnect();
            return;
        }

        const element = /** @type {HTMLElement} */ ($target[0]);
        const style = getComputedStyle(element);
        height = parseInt(style.height);
        width = parseInt(style.width);
        top = parseInt(style.top);
        left = parseInt(style.left);
        right = parseInt(style.right);
        bottom = parseInt(style.bottom);
        maxX = width + left;
        maxY = height + top;
        winWidth = window.innerWidth;
        winHeight = window.innerHeight;

        if (!power_user.movingUIState[elmntName]) power_user.movingUIState[elmntName] = {};

        if (actionType === 'resize') {
            let containerAspectRatio = height / width;
            if ($elmnt.attr('id').startsWith('zoomFor_')) {
                const zoomedAvatarImage = $elmnt.find('.zoomed_avatar_img');
                const imgHeight = zoomedAvatarImage.height();
                const imgWidth = zoomedAvatarImage.width();
                const imageAspectRatio = imgHeight / imgWidth;
                if (containerAspectRatio !== imageAspectRatio) {
                    $elmnt.css('width', $elmnt.width());
                    $elmnt.css('height', $elmnt.width() * imageAspectRatio);
                }
                if (top + $elmnt.height() >= winHeight) {
                    $elmnt.css('height', winHeight - top - 1 + 'px');
                    $elmnt.css('width', (winHeight - top - 1) / imageAspectRatio + 'px');
                }
                if (left + $elmnt.width() >= winWidth) {
                    $elmnt.css('width', winWidth - left - 1 + 'px');
                    $elmnt.css('height', (winWidth - left - 1) * imageAspectRatio + 'px');
                }
            } else {
                if (top + $elmnt.height() >= winHeight) $elmnt.css('height', winHeight - top - 1 + 'px');
                if (left + $elmnt.width() >= winWidth) $elmnt.css('width', winWidth - left - 1 + 'px');
            }
            $elmnt.css({ left, top });
            $elmnt.off('mouseup').on('mouseup', () => {
                if (
                    power_user.movingUIState[elmntName].width === $elmnt.width() &&
                    power_user.movingUIState[elmntName].height === $elmnt.height()
                ) return;
                savePositionAndSize();
                observer.disconnect();
            });
        } else if (actionType === 'drag') {
            clampToViewport();
        }

        savePositionAndSize();
    });

    function dragMouseDown(e) {
        if (e) {
            actionType = 'drag';
            isMouseDown = true;
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
        }
        $(document).on('mouseup', closeDragElement);
        $(document).on('mousemove', elementDrag);
    }

    function elementDrag(e) {
        if (!power_user.movingUIState[elmntName]) power_user.movingUIState[elmntName] = {};
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        $elmnt.attr('data-dragged', 'true');
        $elmnt.css('left', ($elmnt.offset().left - pos1) + 'px');
        $elmnt.css('top', ($elmnt.offset().top - pos2) + 'px');
        $elmnt.css('margin', 'unset');
        $elmnt.css('height', height);
        $elmnt.css('width', width);
    }

    function closeDragElement() {
        isMouseDown = false;
        actionType = null;
        $(document).off('mouseup', closeDragElement);
        $(document).off('mousemove', elementDrag);
        $elmnt.attr('data-dragged', 'false');
        observer.disconnect();
        savePositionAndSize();
    }

    if ($elmntHeader.length) {
        $elmntHeader.off('mousedown').on('mousedown', (e) => {
            if ($(e.target).hasClass('drag-grabber')) {
                actionType = 'drag';
                isMouseDown = true;
                observer.observe($elmnt[0], { attributes: true, attributeFilter: ['style'] });
                dragMouseDown(e);
            }
        });
    }

    $elmnt.off('mousedown').on('mousedown', (e) => {
        const rect = $elmnt[0].getBoundingClientRect();
        const resizeMargin = 16;
        const isNearRight = e.clientX > rect.right - resizeMargin;
        const isNearBottom = e.clientY > rect.bottom - resizeMargin;
        if (isNearRight && isNearBottom) {
            actionType = 'resize';
            isMouseDown = true;
            observer.observe($elmnt[0], { attributes: true, attributeFilter: ['style'] });
        }
    });

    $elmnt.off('mouseup').on('mouseup', () => {
        isMouseDown = false;
        actionType = null;
        observer.disconnect();
    });
}

export async function initMovingUI() {
    if (!isMobile() && power_user.movingUI === true) {
        console.debug('START MOVING UI');
        dragElement($('#sheld'));
        dragElement($('#left-nav-panel'));
        dragElement($('#right-nav-panel'));
        dragElement($('#WorldInfo'));
        dragElement($('#floatingPrompt'));
        dragElement($('#logprobsViewer'));
        dragElement($('#cfgConfig'));
    }
}

/**@type {HTMLTextAreaElement} */
const sendTextArea = document.querySelector('#send_textarea');
const chatBlock = document.getElementById('chat');
const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

// Max height is capped by CSS at 50% of window height.
function autoFitSendTextArea() {
    const originalScrollBottom = chatBlock.scrollHeight - (chatBlock.scrollTop + chatBlock.offsetHeight);

    sendTextArea.style.height = '1px'; // Reset height to 1px to force recalculation of scrollHeight
    const newHeight = sendTextArea.scrollHeight;
    sendTextArea.style.height = `${newHeight}px`;

    if (!isFirefox) {
        chatBlock.scrollTop = chatBlock.scrollHeight - (chatBlock.offsetHeight + originalScrollBottom);
    }
}
export const autoFitSendTextAreaDebounced = debounce(autoFitSendTextArea, debounce_timeout.short);

// ---------------------------------------------------

// The pin of #right-nav-panel (#rm_button_panel_pin) and of #char-info-panel (#charInfo_button_panel_pin).
function applyRightNavPin() {
    accountStorage.setItem('NavLockOn', $(RPanelPin).prop('checked'));
    if ($(RPanelPin).prop('checked') == true) {
        $(RightNavPanel).addClass('pinnedOpen');
        $(RightNavDrawerIcon).addClass('drawerPinnedOpen');
    } else {
        $(RightNavPanel).removeClass('pinnedOpen');
        $(RightNavDrawerIcon).removeClass('drawerPinnedOpen');

        // #char-info-panel can stay open independent of this pin, so it's excluded below.
        if ($(RightNavPanel).hasClass('openDrawer') && $('.openDrawer').not(CharInfoPanel).length > 1) {
            const toggle = $('#unimportantYes');
            doNavbarIconClick.call(toggle);
        }
    }
}

function applyCharInfoPin() {
    accountStorage.setItem('CharInfoNavLockOn', $(CharInfoPanelPin).prop('checked'));
    if ($(CharInfoPanelPin).prop('checked') == true) {
        $(CharInfoPanel).addClass('pinnedOpen');
        $(CharInfoDrawerIcon).addClass('drawerPinnedOpen');
    } else {
        $(CharInfoPanel).removeClass('pinnedOpen');
        $(CharInfoDrawerIcon).removeClass('drawerPinnedOpen');

        // #right-nav-panel can stay open independent of this pin, so it's excluded below.
        if ($(CharInfoPanel).hasClass('openDrawer') && $('.openDrawer').not(RightNavPanel).length > 1) {
            const toggle = $('#charInfoHolder>.drawer-toggle');
            doNavbarIconClick.call(toggle);
        }
    }
}

/** Applies power_user.stacked_drawers to the right-side panels and their pins. */
export function onStackedDrawersChanged() {
    // With stacked drawers off, the two right-side pins act as one; if they differ, pinned wins.
    if (!power_user.stacked_drawers && $(RPanelPin).prop('checked') !== $(CharInfoPanelPin).prop('checked')) {
        $(RPanelPin).prop('checked', true);
        $(CharInfoPanelPin).prop('checked', true);
        applyRightNavPin();
        applyCharInfoPin();
    }
    keepOneRightPanelOpen();
}

export function initRossMods() {
    checkStatusDebounced();

    if (power_user.auto_load_chat) {
        RA_autoloadchat();
    }

    if (power_user.auto_connect) {
        RA_autoconnect();
    }

    $('#main_api').on('change', function () {
        var PrevAPI = main_api;
        setTimeout(() => RA_autoconnect(PrevAPI), 100);
    });

    $('#api_button').on('click', () => checkStatusDebounced());

    //toggle pin class when lock toggle clicked
    $(RPanelPin).on('click', function () {
        applyRightNavPin();
        if (!power_user.stacked_drawers) {
            $(CharInfoPanelPin).prop('checked', $(RPanelPin).prop('checked'));
            applyCharInfoPin();
        }
    });
    $(LPanelPin).on('click', function () {
        accountStorage.setItem('LNavLockOn', $(LPanelPin).prop('checked'));
        if ($(LPanelPin).prop('checked') == true) {
            //console.log('adding pin class to Left nav');
            $(LeftNavPanel).addClass('pinnedOpen');
            $(LeftNavDrawerIcon).addClass('drawerPinnedOpen');
        } else {
            //console.log('removing pin class from Left nav');
            $(LeftNavPanel).removeClass('pinnedOpen');
            $(LeftNavDrawerIcon).removeClass('drawerPinnedOpen');

            if ($(LeftNavPanel).hasClass('openDrawer') && $('.openDrawer').length > 1) {
                const toggle = $('#ai-config-button>.drawer-toggle');
                doNavbarIconClick.call(toggle);
            }
        }
    });

    $(WIPanelPin).on('click', async function () {
        accountStorage.setItem('WINavLockOn', $(WIPanelPin).prop('checked'));
        if ($(WIPanelPin).prop('checked') == true) {
            console.debug('adding pin class to WI');
            $(WorldInfo).addClass('pinnedOpen');
            $(WIDrawerIcon).addClass('drawerPinnedOpen');
        } else {
            console.debug('removing pin class from WI');
            $(WorldInfo).removeClass('pinnedOpen');
            $(WIDrawerIcon).removeClass('drawerPinnedOpen');

            if ($(WorldInfo).hasClass('openDrawer') && $('.openDrawer').length > 1) {
                console.debug('closing WI after lock removal');
                const toggle = $('#WI-SP-button>.drawer-toggle');
                doNavbarIconClick.call(toggle);
            }
        }
    });

    $(CharInfoPanelPin).on('click', function () {
        applyCharInfoPin();
        if (!power_user.stacked_drawers) {
            $(RPanelPin).prop('checked', $(CharInfoPanelPin).prop('checked'));
            applyRightNavPin();
        }
    });

    const wasOpen = readSavedPanelOpenStates();
    if (!isMobile()) {
        // A reload restores each pinned panel as it was left; unpinned panels start closed.
        const pinnable = [
            { panel: RightNavPanel, icon: RightNavDrawerIcon, pin: RPanelPin, lockKey: 'NavLockOn' },
            { panel: CharInfoPanel, icon: CharInfoDrawerIcon, pin: CharInfoPanelPin, lockKey: 'CharInfoNavLockOn' },
            { panel: LeftNavPanel, icon: LeftNavDrawerIcon, pin: LPanelPin, lockKey: 'LNavLockOn' },
            { panel: WorldInfo, icon: WIDrawerIcon, pin: WIPanelPin, lockKey: 'WINavLockOn' },
        ];
        const reopened = [];
        // With stacked drawers off, the two right-side pins act as one; if they differ, pinned wins.
        const rightPanelPinned = ['NavLockOn', 'CharInfoNavLockOn'].some(key => accountStorage.getItem(key) === 'true');
        for (const { panel, icon, pin, lockKey } of pinnable) {
            const linked = !power_user.stacked_drawers && panel.classList.contains('fillRight');
            const pinned = linked ? rightPanelPinned : accountStorage.getItem(lockKey) === 'true';
            $(pin).prop('checked', pinned);
            if (linked) accountStorage.setItem(lockKey, pinned);
            if (!pinned) continue;
            $(panel).addClass('pinnedOpen');
            $(icon).addClass('drawerPinnedOpen');
            if (wasOpen[panel.id]) {
                $(panel).addClass('openDrawer').removeClass('closedDrawer');
                $(icon).addClass('openIcon').removeClass('closedIcon');
                reopened.push(panel);
            }
        }

        // Fronted .fillRight panels first (the one last in front goes on top of the other), then the rest in list order.
        const savedFront = accountStorage.getItem('FillRightFront');
        const fillRightFirst = el => Number(!el.classList.contains('fillRight'));
        reopened.sort((x, y) => fillRightFirst(x) - fillRightFirst(y) || Number(x.id === savedFront) - Number(y.id === savedFront));
        reopened.forEach(el => frontDrawer(el.id));
        keepOneRightPanelOpen();
    }

    var chatbarInFocus = false;
    $('#send_textarea').on('focus', function () {
        chatbarInFocus = true;
    });

    $('#send_textarea').on('blur', function () {
        chatbarInFocus = false;
    });

    $(SelectedCharacterTab).on('click', function () { accountStorage.setItem('SelectedNavTab', 'rm_button_selected_ch'); });

    $(document).on('click', '.character_select', function () {
        // Resolve by avatar (the stable id), the only identifier a character row carries.
        const characterId = $(this).attr('data-avatar');
        setActiveCharacter(characterId);
        setActiveGroup(null);
        saveSettingsDebounced('active_character', 'active_group');
    });

    $(document).on('click', '.group_select', function () {
        const groupId = $(this).attr('data-grid');
        setActiveCharacter(null);
        setActiveGroup(groupId);
        saveSettingsDebounced('active_character', 'active_group');
    });

    const cssAutofit = CSS.supports('field-sizing', 'content');

    if (cssAutofit) {
        let lastHeight = chatBlock.offsetHeight;
        const chatBlockResizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target !== chatBlock) {
                    continue;
                }

                const threshold = 1;
                const newHeight = chatBlock.offsetHeight;
                const deltaHeight = newHeight - lastHeight;
                const isScrollAtBottom = Math.abs(chatBlock.scrollHeight - chatBlock.scrollTop - newHeight) <= threshold;

                if (!isScrollAtBottom && Math.abs(deltaHeight) > threshold) {
                    chatBlock.scrollTop -= deltaHeight;
                }
                lastHeight = newHeight;
            }
        });

        chatBlockResizeObserver.observe(chatBlock);
    }

    sendTextArea.addEventListener('input', () => {
        saveUserInputDebounced();

        if (cssAutofit) {
            // Unset modifications made with a manual resize
            sendTextArea.style.height = 'auto';
            return;
        }

        const hasContent = sendTextArea.value !== '';
        const fitsCurrentSize = sendTextArea.scrollHeight <= sendTextArea.offsetHeight;
        const isScrollbarShown = sendTextArea.clientWidth < sendTextArea.offsetWidth;
        const isHalfScreenHeight = sendTextArea.offsetHeight >= window.innerHeight / 2;
        const needsDebounce = hasContent && (fitsCurrentSize || (isScrollbarShown && isHalfScreenHeight));
        if (needsDebounce) autoFitSendTextAreaDebounced();
        else autoFitSendTextArea();
    });

    restoreUserInput();

    // Swipe gestures (see: https://www.npmjs.com/package/swiped-events)
    document.addEventListener('swiped-left', function (e) {
        if (power_user.gestures === false) {
            return;
        }
        if (Popup.util.isPopupOpen()) {
            return;
        }
        if (!$(e.target).closest('#sheld').length) {
            return;
        }
        if ($('#curEditTextarea').length) {
            // Don't swipe while in text edit mode - iOS selection gestures get picked up as swipes
            return;
        }
        // Resolve against the message the gesture happened on, not always the last one - swipeAllMessages
        // lets earlier messages be swiped too.
        var swipeTargetMes = $(e.target).closest('.mes');
        if (swipeTargetMes.length) {
            var SwipeButR = swipeTargetMes.find('.swipe_right');
            if (SwipeButR.is(':visible')) {
                SwipeButR.trigger('click');
            }
        }
    });
    document.addEventListener('swiped-right', function (e) {
        if (power_user.gestures === false) {
            return;
        }
        if (Popup.util.isPopupOpen()) {
            return;
        }
        if (!$(e.target).closest('#sheld').length) {
            return;
        }
        if ($('#curEditTextarea').length) {
            // Don't swipe while in text edit mode - iOS selection gestures get picked up as swipes
            return;
        }
        // See the swiped-left handler above for why this targets the gesture's message.
        var swipeTargetMes = $(e.target).closest('.mes');
        if (swipeTargetMes.length) {
            var SwipeButL = swipeTargetMes.find('.swipe_left');
            if (SwipeButL.is(':visible')) {
                SwipeButL.trigger('click');
            }
        }
    });


    function isInputElementInFocus() {
        //return $(document.activeElement).is(":input");
        var focused = $(':focus');
        if (focused.is('input') || focused.is('textarea') || focused.prop('contenteditable') == 'true') {
            if (focused.attr('id') === 'send_textarea') {
                return false;
            }
            return true;
        }
        return false;
    }

    function isModifiedKeyboardEvent(event) {
        return (event instanceof KeyboardEvent &&
            (event.shiftKey ||
            event.ctrlKey ||
            event.altKey ||
            event.metaKey));
    }

    $(document).on('keydown', async function (event) {
        await processHotkeys(event.originalEvent);
    });

    const hotkeyTargets = {
        'send_textarea': sendTextArea,
        'dialogue_popup_input': document.querySelector('#dialogue_popup_input'),
    };

    //Additional hotkeys CTRL+ENTER and CTRL+UPARROW
    /**
     * @param {KeyboardEvent} event
     */
    async function processHotkeys(event) {
        // Default hotkeys and shortcuts shouldn't work if any popup is currently open
        if (Popup.util.isPopupOpen()) {
            return;
        }

        //Enter to send when send_textarea in focus
        if (document.activeElement == hotkeyTargets.send_textarea) {
            const sendOnEnter = shouldSendOnEnter();
            if (!event.isComposing && !event.shiftKey && !event.ctrlKey && !event.altKey && event.key == 'Enter' && sendOnEnter) {
                event.preventDefault();
                requestTextareaSend('enter');
                return;
            }
        }
        if (document.activeElement == hotkeyTargets.dialogue_popup_input && !isMobile()) {
            if (!event.shiftKey && !event.ctrlKey && event.key == 'Enter') {
                event.preventDefault();
                $('#dialogue_popup_ok').trigger('click');
                return;
            }
        }
        //ctrl+shift+up to scroll to context line
        if (event.shiftKey && event.ctrlKey && event.key == 'ArrowUp') {
            event.preventDefault();
            let contextLine = $('.lastInContext');
            if (contextLine.length !== 0) {
                $('#chat').animate({
                    scrollTop: contextLine.offset().top - $('#chat').offset().top + $('#chat').scrollTop(),
                }, 300);
            } else { toastr.warning('Context line not found, send a message first!'); }
            return;
        }
        //ctrl+shift+down to scroll to bottom of chat
        if (event.shiftKey && event.ctrlKey && event.key == 'ArrowDown') {
            event.preventDefault();
            $('#chat').animate({
                scrollTop: $('#chat').prop('scrollHeight'),
            }, 300);
            return;
        }

        // Alt+Enter or AltGr+Enter to Continue
        if ((event.altKey || (event.altKey && event.ctrlKey)) && event.key == 'Enter') {
            if (is_send_press == false) {
                console.debug('Continuing with Alt+Enter');
                $('#option_continue').trigger('click');
                return;
            }
        }

        // Ctrl+Enter regenerates the last response, or accepts an in-progress edit instead.
        // Deliberately unscoped: only one message can be in edit mode at a time, so this always
        // matches the message actually being edited, not necessarily the last one.
        if (event.ctrlKey && event.key == 'Enter') {
            if (handleFieldEditKey('confirm')) {
                return;
            }
            const editMesDone = $('.mes_edit_done:visible');
            const reasoningMesDone = $('.mes_reasoning_edit_done:visible');
            if (editMesDone.length > 0) {
                console.debug('Accepting edits with Ctrl+Enter');
                $('#send_textarea').trigger('focus');
                editMesDone.trigger('click');
                return;
            } else if (reasoningMesDone.length > 0) {
                console.debug('Accepting edits with Ctrl+Enter');
                $('#send_textarea').trigger('focus');
                reasoningMesDone.trigger('click');
                return;
            } else if (is_send_press == false) {
                const skipConfirmKey = 'RegenerateWithCtrlEnter';
                const skipConfirm = accountStorage.getItem(skipConfirmKey) === 'true';
                function doRegenerate() {
                    console.debug('Regenerating with Ctrl+Enter');
                    $('#option_regenerate').trigger('click');
                    $('#options').hide();
                }

                // If there is input text, we do not trigger a regenerate - we just send it
                if ($('#send_textarea').val() !== '') {
                    if (shouldSendOnEnter()) {
                        console.debug('Sending with Ctrl+Enter');
                        event.preventDefault();
                        requestTextareaSend('enter');
                    } else {
                        console.debug('Text area is not empty, but send on enter is disabled');
                    }
                    return;
                }

                if (skipConfirm) {
                    doRegenerate();
                } else {
                    let regenerateWithCtrlEnter = false;
                    const result = await Popup.show.confirm('Regenerate Message', 'Are you sure you want to regenerate the latest message?', {
                        customInputs: [{ id: 'regenerateWithCtrlEnter', label: 'Don\'t ask again' }],
                        onClose: (popup) => {
                            regenerateWithCtrlEnter = Boolean(popup.inputResults.get('regenerateWithCtrlEnter') ?? false);
                        },
                    });
                    if (!result) {
                        return;
                    }

                    accountStorage.setItem(skipConfirmKey, String(regenerateWithCtrlEnter));
                    doRegenerate();
                }
                return;
            } else {
                console.debug('Ctrl+Enter ignored');
            }
        }

        function isNanogallery2LightboxActive() {
            return document.body.classList.contains('nGY2_body_scrollbar');
        }

        if (event.key == 'ArrowLeft') {        //swipes left
            if (
                isSwipingAllowed() &&
                !isNanogallery2LightboxActive() &&
                $('#send_textarea').val() === '' &&
                $('#shadow_select_chat_popup').css('display') === 'none' &&
                !isInputElementInFocus() &&
                !(document.activeElement instanceof HTMLVideoElement)
            ) {
                if (!isModifiedKeyboardEvent(event)) {
                    $('.swipe_left:last').trigger('click', { source: SWIPE_SOURCE.KEYBOARD, repeated: event.repeat });
                    return;
                }
            }
        }
        if (event.key == 'ArrowRight') { //swipes right
            if (
                isSwipingAllowed() &&
                !isNanogallery2LightboxActive() &&
                $('#send_textarea').val() === '' &&
                $('#shadow_select_chat_popup').css('display') === 'none' &&
                !isInputElementInFocus() &&
                !(document.activeElement instanceof HTMLVideoElement)
            ) {
                if (!isModifiedKeyboardEvent(event)) {
                    $('.swipe_right:last').trigger('click', { source: SWIPE_SOURCE.KEYBOARD, repeated: event.repeat });
                    return;
                }
            }
        }


        if (event.ctrlKey && event.key == 'ArrowUp') { //edits last USER message if chatbar is empty and focused
            if (
                hotkeyTargets.send_textarea.value === '' &&
                chatbarInFocus === true &&
                ($('.swipe_right:last').css('display') === 'flex' || $('.last_mes').attr('is_system') === 'true') &&
                $('#shadow_select_chat_popup').css('display') === 'none'
            ) {
                const isUserMesList = document.querySelectorAll('div[is_user="true"]');
                const lastIsUserMes = isUserMesList[isUserMesList.length - 1];
                const editMes = lastIsUserMes.querySelector('.mes_block .mes_edit');
                if (editMes !== null) {
                    $(editMes).trigger('click');
                    return;
                }
            }
        }

        if (event.key == 'ArrowUp') { //edits last message if chatbar is empty and focused
            if (
                hotkeyTargets.send_textarea.value === '' &&
                chatbarInFocus === true &&
                //$('.swipe_right:last').css('display') === 'flex' &&
                $('.last_mes .mes_buttons').is(':visible') &&
                $('#shadow_select_chat_popup').css('display') === 'none'
            ) {
                const lastMes = document.querySelector('.last_mes');
                const editMes = lastMes.querySelector('.mes_block .mes_edit');
                if (editMes !== null) {
                    $(editMes).trigger('click');
                    return;
                }
            }
        }

        if (event.key == 'Escape') { //closes various panels
            //dont override Escape hotkey functions from script.js
            //"close edit box" and "cancel stream generation".
            if ($('#curEditTextarea').is(':visible') || $('#mes_stop').is(':visible')) {
                console.debug('escape key, but deferring to script.js routines');
                return;
            }

            if ($('#dialogue_popup').is(':visible')) {
                if ($('#dialogue_popup_cancel').is(':visible')) {
                    $('#dialogue_popup_cancel').trigger('click');
                    return;
                } else {
                    $('#dialogue_popup_ok').trigger('click');
                    return;
                }
            }

            if ($('#select_chat_popup').is(':visible')) {
                $('#select_chat_cross').trigger('click');
                return;
            }

            if ($('#dialogue_del_mes_cancel').is(':visible')) {
                $('#dialogue_del_mes_cancel').trigger('click');
                return;
            }

            if ($('.drawer-content')
                .not('#WorldInfo')
                .not('#left-nav-panel')
                .not('#right-nav-panel')
                .not('#floatingPrompt')
                .not('#cfgConfig')
                .not('#logprobsViewer')
                .not('#movingDivs > div')
                .is(':visible')) {
                let visibleDrawerContent = $('.drawer-content:visible')
                    .not('#WorldInfo')
                    .not('#left-nav-panel')
                    .not('#right-nav-panel')
                    .not('#floatingPrompt')
                    .not('#cfgConfig')
                    .not('#logprobsViewer')
                    .not('#movingDivs > div');
                $(visibleDrawerContent).parent().find('.drawer-icon').trigger('click');
                return;
            }

            if ($('#logprobsViewer').is(':visible')) {
                $('#logprobsViewerClose').trigger('click');
                return;
            }

            if ($('#cfgConfig').is(':visible')) {
                $('#CFGClose').trigger('click');
                return;
            }

            if ($('#floatingPrompt').is(':visible')) {
                $('#ANClose').trigger('click');
                return;
            }

            if ($('#WorldInfo').is(':visible')) {
                $('#WIDrawerIcon').trigger('click');
                return;
            }

            const movingDivs = $('#movingDivs > div').toArray().reverse();
            for (const div of movingDivs) {
                if ($(div).is(':visible')) {
                    $(div).find('.floating_panel_close, .dragClose').trigger('click');
                    return;
                }
            }

            if ($('#left-nav-panel').is(':visible') &&
                $(LPanelPin).prop('checked') === false) {
                $('#leftNavDrawerIcon').trigger('click');
                return;
            }

            if ($('#right-nav-panel').is(':visible') &&
                $(RPanelPin).prop('checked') === false) {
                $('#rightNavDrawerIcon').trigger('click');
                return;
            }
            if ($('.draggable').is(':visible')) {
                $('.draggable:first').remove();
                return;
            }
        }


        if (event.ctrlKey && /^[1-9]$/.test(event.key)) {
            // This will eventually be to trigger quick replies
            // event.preventDefault();
        }
    }
}
