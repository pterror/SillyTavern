import { handleFieldEditKey } from './character-field-editor.js';
import { macrosIn, withMacroValues } from './safe-macros.js';
import { MacroValues, currentPageMacroFacts } from './macro-values.js';
import { askOnChatOpen, chatOpenPart } from './chat-open-parts.js';
import { cardTokenTexts } from './card-token-texts.js';
import { getFocusedField } from './live-editor/registry.js';
import { DOMPurify, Bowser } from '../lib.js';

import {
    online_status,
    is_send_press,
    saveSettingsDebounced,
    buildAvatarList,
    selectCharacterByAvatar,
    menu_type,
    openChatMacroScope,
    requestTextareaSend,
    doNavbarIconClick,
    restoreDrawerOrder,
    keepOneRightPanelOpen,
    readSavedPanelOpenStates,
    isSwipingAllowed,
    cardToGreetingsModel,
    getCurrentChatId,
} from '../script.js';
import { queryWithSortFallback, characterToEntity, groupToEntity, entitiesFilter } from './character-list.js';
import { active_character, active_group, setActiveCharacter, setActiveGroup } from './app-selection-state.js';
import { main_api, max_context } from './generation-params.js';
import { charactersStore } from './character-store.js';

import {
    power_user,
    send_on_enter_options,
} from './power-user.js';

import { characterRepository, buildCharacterQuery, normalizeQueryRow } from './character-repository.js';
import { getRandomSortSeed } from './random-sort.js';
import { selected_group, is_group_generating, openGroupById } from './group-chats.js';
import { applyTagsOnCharacterSelect } from './tags.js';
import {
    SECRET_KEYS,
    secret_state,
} from './secrets.js';
import { debounce, getStringHash, isValidUrl } from './utils.js';
import { drawerStackChanged } from './drawer-stack.js';
import { chat_completion_sources, oai_settings, POLLINATIONS_ENDPOINT } from './chat-completion-settings.js';
import { getRememberedTokenizerAnswer, getTokenCountsWithTokenizer, getTokenizerState, takeCountAnswer } from './tokenizers.js';
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

export { humanizedDateTime } from './humanized-date.js';

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

export function countCharTokensWhenShown() {
    countTokensWhenShownDebounced();
}

export function countCharTokensWhenShownSoon() {
    countTokensWhenShownSoonDebounced();
}

export function onCharacterEditorMaybeShown() {
    if (editorCountPending && isCharacterEditorShowing()) {
        RA_CountCharTokens();
    }
}

askOnChatOpen('card_token_counts', owner => (owner.type === 'character' ? { tokenizer: getTokenizerState(), macro_facts: currentPageMacroFacts() } : undefined));

/**
 * @returns {{ part: any, counts: Map<string, number> } | null}
 */
function openedCardCounts() {
    if (menu_type === 'create') return null;
    const avatar = String($('#avatar_url_pole').val() ?? '');
    const part = chatOpenPart('card_token_counts', getCurrentChatId());
    if (!part || part.avatar !== avatar || JSON.stringify(part.state) !== JSON.stringify(getTokenizerState())) return null;
    const card = charactersStore.get(avatar);
    if (!card) return null;
    const texts = cardTokenTexts(card, cardToGreetingsModel(card).greetings);
    if (!Array.isArray(part.counts) || texts.length !== part.counts.length) return null;
    return { part, counts: new Map(texts.map((text, i) => [text, Number(part.counts[i])])) };
}

export async function RA_CountCharTokens() {
    editorCountPending = false;
    counterNonce = Date.now();
    const counterNonceLocal = counterNonce;
    let total_tokens = 0;
    let permanent_tokens = 0;
    let totalAnswer = getRememberedTokenizerAnswer();

    const tokenCounters = document.querySelectorAll('[data-token-counter]');

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
            pending.push({ counter, input, isPermanent, valueHash, value });
        }
    }

    /**
     * @param {typeof pending[number]} p
     * @param {number} tokens
     * @param {import('./tokenizers.js').CurrentTokenizer|null} answer
     */
    const showCount = (p, tokens, answer) => {
        p.counter.text(tokens);
        renderCountBasis(p.counter, answer);
        p.counter.closest('.inline-drawer').toggleClass('token-count-zero', tokens === 0);
        p.counter.closest('small').toggle(tokens !== 0);
        total_tokens += tokens;
        permanent_tokens += p.isPermanent ? tokens : 0;
        p.input.data('last-value-hash', p.valueHash);
    };

    const opened = pending.length > 0 ? openedCardCounts() : null;
    if (opened) {
        const unknown = pending.filter(p => !opened.counts.has(p.value));
        if (unknown.length < pending.length) {
            takeCountAnswer(opened.part.state, opened.part);
            totalAnswer = opened.part.tokenizer;
            for (const p of pending) {
                if (opened.counts.has(p.value)) showCount(p, /** @type {number} */ (opened.counts.get(p.value)), opened.part.tokenizer);
            }
        }
        pending.splice(0, pending.length, ...unknown);
    }

    if (pending.length > 0) {
        const values = new MacroValues(() => ({ ...openChatMacroScope(), avatar_url: String($('#avatar_url_pole').val() ?? '') }));
        if (menu_type !== 'create') await values.wantMacros(pending.flatMap(p => macrosIn(p.value)));
        if (counterNonceLocal !== counterNonce) {
            return;
        }
        const toCount = pending.map(p => (menu_type === 'create' ? p.value : withMacroValues(p.value, values.valueOf)));
        const { counts: counted, answer } = await getTokenCountsWithTokenizer(toCount);
        totalAnswer = answer;

        if (counterNonceLocal !== counterNonce) {
            return;
        }

        pending.forEach((p, i) => showCount(p, counted[i], answer));
    }

    const tokenLimit = Math.max(((main_api !== 'openai' ? max_context : oai_settings.openai_max_context) / 2), 1024);
    const showWarning = (total_tokens > tokenLimit);
    $('#result_info_total_tokens').text(total_tokens);
    renderCountBasis($('#result_info_total_tokens'), totalAnswer);
    $('#result_info_permanent_tokens').text(permanent_tokens);
    $('#result_info_text').toggleClass('neutral_warning', showWarning);
    $('#chartokenwarning').toggle(showWarning);
}
async function RA_autoloadchat() {
    if (active_character !== null && active_character !== undefined) {
        const found = await selectCharacterByAvatar(String(active_character), { toastMissing: false });
        if (found) {
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

export async function favsToHotswap() {
    try {
        return await favsToHotswapImpl();
    } catch (error) {
        console.warn('[favsToHotswap] Could not refresh the hotswap row:', error);
    }
}

async function favsToHotswapImpl() {
    const container = $('#right-nav-panel .hotswap');

    const FAVS_LIMIT = 25;

    const isRandom = power_user.sort_order === 'random';
    const sortField = isRandom ? 'random' : power_user.sort_field;
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

/**
 * Lets a floating window be dragged by its header (`#<id>header`, grabbed by its `.drag-grabber`), kept inside the
 * window. Where it was dragged isn't kept.
 * @param {JQuery<HTMLElement>} $elmnt
 */
export function dragElement($elmnt) {
    const elmntName = $elmnt.attr('id');
    const $elmntHeader = $(`#${$.escapeSelector(elmntName)}header`);
    let lastX = 0, lastY = 0;

    function elementDrag(e) {
        e.preventDefault();
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        const offset = $elmnt.offset();
        const left = Math.min(Math.max(0, offset.left + dx), window.innerWidth - $elmnt.outerWidth());
        const top = Math.min(Math.max(0, offset.top + dy), window.innerHeight - $elmnt.outerHeight());
        $elmnt.css({ left: `${left}px`, top: `${top}px`, margin: 'unset' });
        $elmnt.attr('data-dragged', 'true');
        drawerStackChanged();
    }

    function closeDragElement() {
        $(document).off('mouseup', closeDragElement);
        $(document).off('mousemove', elementDrag);
        $elmnt.attr('data-dragged', 'false');
    }

    $elmntHeader.off('mousedown').on('mousedown', (e) => {
        if (!$(e.target).hasClass('drag-grabber')) return;
        e.preventDefault();
        lastX = e.clientX;
        lastY = e.clientY;
        $(document).on('mouseup', closeDragElement);
        $(document).on('mousemove', elementDrag);
    });
}

export async function initMovingUI() {}

/**@type {HTMLTextAreaElement} */
const sendTextArea = document.querySelector('#send_textarea');
const chatBlock = document.getElementById('chat');
const isFirefox = navigator.userAgent.toLowerCase().indexOf('firefox') > -1;

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

function applyRightNavPin() {
    accountStorage.setItem('NavLockOn', $(RPanelPin).prop('checked'));
    if ($(RPanelPin).prop('checked') == true) {
        $(RightNavPanel).addClass('pinnedOpen');
        $(RightNavDrawerIcon).addClass('drawerPinnedOpen');
    } else {
        $(RightNavPanel).removeClass('pinnedOpen');
        $(RightNavDrawerIcon).removeClass('drawerPinnedOpen');

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

        if ($(CharInfoPanel).hasClass('openDrawer') && $('.openDrawer').not(RightNavPanel).length > 1) {
            const toggle = $('#charInfoHolder>.drawer-toggle');
            doNavbarIconClick.call(toggle);
        }
    }
}

export function onStackedDrawersChanged() {
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
        const pinnable = [
            { panel: RightNavPanel, icon: RightNavDrawerIcon, pin: RPanelPin, lockKey: 'NavLockOn' },
            { panel: CharInfoPanel, icon: CharInfoDrawerIcon, pin: CharInfoPanelPin, lockKey: 'CharInfoNavLockOn' },
            { panel: LeftNavPanel, icon: LeftNavDrawerIcon, pin: LPanelPin, lockKey: 'LNavLockOn' },
            { panel: WorldInfo, icon: WIDrawerIcon, pin: WIPanelPin, lockKey: 'WINavLockOn' },
        ];
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
            }
        }
    }
    restoreDrawerOrder();
    keepOneRightPanelOpen();

    var chatbarInFocus = false;
    $('#send_textarea').on('focus', function () {
        chatbarInFocus = true;
    });

    $('#send_textarea').on('blur', function () {
        chatbarInFocus = false;
    });

    $(SelectedCharacterTab).on('click', function () { accountStorage.setItem('SelectedNavTab', 'rm_button_selected_ch'); });

    $(document).on('click', '.character_select', function () {
        const characterId = $(this).attr('data-avatar');
        setActiveCharacter(characterId);
        setActiveGroup(null);
    });

    $(document).on('click', '.group_select', function () {
        const groupId = $(this).attr('data-grid');
        setActiveCharacter(null);
        setActiveGroup(groupId);
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
            return;
        }
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
            return;
        }
        var swipeTargetMes = $(e.target).closest('.mes');
        if (swipeTargetMes.length) {
            var SwipeButL = swipeTargetMes.find('.swipe_left');
            if (SwipeButL.is(':visible')) {
                SwipeButL.trigger('click');
            }
        }
    });


    function isInputElementInFocus() {
        const field = getFocusedField();
        if (field) {
            return field.id !== 'send_textarea';
        }
        return $(':focus').prop('contenteditable') == 'true';
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
        if (Popup.util.isPopupOpen() || document.querySelector('dialog:modal')) {
            return;
        }

        //Enter to send when send_textarea in focus
        if (getFocusedField() == hotkeyTargets.send_textarea) {
            const sendOnEnter = shouldSendOnEnter();
            if (!event.isComposing && !event.shiftKey && !event.ctrlKey && !event.altKey && event.key == 'Enter' && sendOnEnter) {
                event.preventDefault();
                requestTextareaSend('enter');
                return;
            }
        }
        if (getFocusedField() == hotkeyTargets.dialogue_popup_input && !isMobile()) {
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

        if (event.ctrlKey && event.key == 'Enter') {
            if (handleFieldEditKey('confirm')) {
                event.preventDefault();
                return;
            }
            const editMesDone = $('.mes_edit_done:visible');
            const reasoningMesDone = $('.mes_reasoning_edit_done:visible');
            if (editMesDone.length > 0) {
                console.debug('Accepting edits with Ctrl+Enter');
                event.preventDefault();
                $('#send_textarea').trigger('focus');
                editMesDone.trigger('click');
                return;
            } else if (reasoningMesDone.length > 0) {
                console.debug('Accepting edits with Ctrl+Enter');
                event.preventDefault();
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
                const editMes = lastIsUserMes?.querySelector('.mes_block .mes_edit') ?? null;
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

        if (event.key == 'Escape' && !event.defaultPrevented) {
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
