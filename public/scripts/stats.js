// statsHelper.js
import { moment } from '../lib.js';
import { getCurrentCharacter } from '../script.js';
import { getRequestHeaders } from './request-headers.js';
import { humanizeGenTime } from './RossAscends-mods.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { registerDebugFunction } from './power-user.js';
import { t, translate } from './i18n.js';

let charStats = {};

/**
 * Creates an HTML stat block.
 *
 * @param {string} statName - The name of the stat to be displayed.
 * @param {number|string} statValue - The value of the stat to be displayed.
 * @returns {string} - An HTML string representing the stat block.
 */
function createStatBlock(statName, statValue) {
    return `<div class="rm_stat_block">
                <div class="rm_stat_name">${statName}:</div>
                <div class="rm_stat_value">${statValue}</div>
            </div>`;
}

/**
 * Verifies and returns a numerical stat value. If the provided stat is not a number, returns 0.
 *
 * @param {number|string} stat - The stat value to be checked and returned.
 * @returns {number} - The stat value if it is a number, otherwise 0.
 */
function verifyStatValue(stat) {
    return isNaN(Number(stat)) ? 0 : Number(stat);
}

/**
 * Generates an HTML report of stats.
 *
 * @param {string} statsType - "User" or "Character".
 * @param {Object} stats - In the server's per-character shape (src/endpoints/stats.js).
 * @param {{ filled?: boolean, backup?: string|null }} [notes] Whether the first count of the stored chats has
 *   finished, and the old stats file kept from before the stats were counted from messages.
 */
function createHtml(statsType, stats, notes = {}) {
    const timeString = humanizeGenTime(verifyStatValue(stats.total_gen_time));
    const unknownTimes = verifyStatValue(stats.gen_time_unknown_count);
    const firstChat = verifyStatValue(stats.date_first_chat);
    const chatAge = firstChat > 0 && firstChat < Date.now() ? moment(firstChat).fromNow() : t`Never`;
    const statsTypeTranslated = translate(statsType, `stats_header_${statsType}`);

    let html = '<h3>' + t`${statsTypeTranslated} Stats` + '</h3>';
    if (notes.filled === false) {
        html += `<p>${t`Still counting your older chats; these numbers will grow until that's done.`}</p>`;
    }
    html += createStatBlock(statsType === 'User' ? t`Chatting Since` : t`First Interaction`, chatAge);
    html += createStatBlock(t`Chat Time`, unknownTimes > 0
        ? `${timeString} ${t`(plus ${unknownTimes} replies saved without their generation time)`}`
        : timeString);
    html += createStatBlock(t`User Messages`, stats.user_msg_count);
    html += createStatBlock(
        t`Character Messages`,
        stats.non_user_msg_count - stats.total_swipe_count,
    );
    html += createStatBlock(t`User Words`, stats.user_word_count);
    html += createStatBlock(t`Character Words`, stats.non_user_word_count);
    html += createStatBlock(t`Swipes`, stats.total_swipe_count);
    if (notes.backup) {
        html += `<p><small>${t`Your stats from before they were counted from your chats are kept in ${notes.backup} in your data folder.`}</small></p>`;
    }

    return callGenericPopup(html, POPUP_TYPE.TEXT);
}

/**
 * Shows the user's stats over every chat, counted by the server from the stored messages.
 */
async function userStatsHandler() {
    const response = await fetch('/api/stats/totals', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });
    if (!response.ok) {
        toastr.error(t`Stats could not be loaded. Try reloading the page.`);
        throw new Error('Error getting stats');
    }
    const { stats, filled, backup } = await response.json();
    createHtml('User', stats, { filled, backup });
}

/**
 * Handles the character stats by getting them from the server and generating the HTML report.
 *
 * @param {Character} character - The character to show stats for.
 */
async function characterStatsHandler(character) {
    await getStats([character.avatar]);
    let myStats = charStats[character.avatar];
    if (myStats === undefined) {
        myStats = {
            total_gen_time: 0,
            user_msg_count: 0,
            non_user_msg_count: 0,
            user_word_count: 0,
            non_user_word_count: 0,
            total_swipe_count: 0,
            date_last_chat: 0,
            date_first_chat: new Date('9999-12-31T23:59:59.999Z').getTime(),
        };
    }
    // Create HTML with stats
    createHtml('Character', myStats);
}

/**
 * Fetches the character stats from the server: the characters named, or with none named, up to the first 1000
 * characters with any messages.
 * @param {string[]} [avatars]
 */
async function getStats(avatars) {
    const response = await fetch('/api/stats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(Array.isArray(avatars) ? { avatars } : {}),
        cache: 'no-cache',
    });

    if (!response.ok) {
        toastr.error('Stats could not be loaded. Try reloading the page.');
        throw new Error('Error getting stats');
    }
    charStats = await response.json();
}

async function recreateStats() {
    const response = await fetch('/api/stats/recreate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
        cache: 'no-cache',
    });

    if (!response.ok) {
        toastr.error(t`Stats could not be recounted. Try reloading the page.`);
        throw new Error('Error recounting stats');
    } else {
        toastr.success(t`Counting your stats again from your chats, in the background.`);
    }
}


/**
 * Kept for upstream callers. The stats are counted by the server from the stored messages, so a message the page
 * processes changes nothing here.
 * @param {Object} _line
 * @param {string} _type
 * @param {Character} _character
 * @param {string} _oldMessage
 */
async function statMesProcess(_line, _type, _character, _oldMessage) { }

export function initStats() {
    $('.rm_stats_button').on('click', function () {
        characterStatsHandler(getCurrentCharacter());
    });
    registerDebugFunction('refreshStats', 'Refresh Stat File', 'Recreates the stats file based on existing chat files', recreateStats);
}

export { userStatsHandler, characterStatsHandler, getStats, statMesProcess, charStats };
