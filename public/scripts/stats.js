// statsHelper.js
import { moment } from '../lib.js';
import { getRequestHeaders, getCurrentCharacter } from '../script.js';
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
 * Calculates total stats from character statistics.
 *
 * @returns {Object} - Object containing total statistics.
 */
function calculateTotalStats() {
    let totalStats = {
        total_gen_time: 0,
        user_msg_count: 0,
        non_user_msg_count: 0,
        user_word_count: 0,
        non_user_word_count: 0,
        total_swipe_count: 0,
        date_last_chat: 0,
        date_first_chat: new Date('9999-12-31T23:59:59.999Z').getTime(),
    };

    for (let stats of Object.values(charStats)) {
        totalStats.total_gen_time += verifyStatValue(stats.total_gen_time);
        totalStats.user_msg_count += verifyStatValue(stats.user_msg_count);
        totalStats.non_user_msg_count += verifyStatValue(
            stats.non_user_msg_count,
        );
        totalStats.user_word_count += verifyStatValue(stats.user_word_count);
        totalStats.non_user_word_count += verifyStatValue(
            stats.non_user_word_count,
        );
        totalStats.total_swipe_count += verifyStatValue(
            stats.total_swipe_count,
        );

        if (verifyStatValue(stats.date_last_chat) != 0) {
            totalStats.date_last_chat = Math.max(
                totalStats.date_last_chat,
                stats.date_last_chat,
            );
        }
        if (verifyStatValue(stats.date_first_chat) != 0) {
            totalStats.date_first_chat = Math.min(
                totalStats.date_first_chat,
                stats.date_first_chat,
            );
        }
    }

    return totalStats;
}

/**
 * Generates an HTML report of stats.
 *
 * This function creates an HTML report from the provided stats, including chat age,
 * chat time, number of user messages and character messages, word count, and swipe count.
 * The stat blocks are tailored depending on the stats type ("User" or "Character").
 *
 * @param {string} statsType - The type of stats (e.g., "User", "Character").
 * @param {Object} stats - The stats data. Expected keys in this object include:
 *      total_gen_time - total generation time
 *      date_first_chat - timestamp of the first chat
 *      date_last_chat - timestamp of the most recent chat
 *      user_msg_count - count of user messages
 *      non_user_msg_count - count of non-user messages
 *      user_word_count - count of words used by the user
 *      non_user_word_count - count of words used by the non-user
 *      total_swipe_count - total swipe count
 */
function createHtml(statsType, stats) {
    // Get time string
    let timeStirng = humanizeGenTime(stats.total_gen_time);
    let chatAge = 'Never';
    if (stats.date_first_chat < Date.now()) {
        chatAge = moment
            .duration(stats.date_last_chat - stats.date_first_chat)
            .humanize();
    }
    let statsTypeTranslated = translate(statsType, `stats_header_${statsType}`);

    // Create popup HTML with stats
    let html = '<h3>' + t`${statsTypeTranslated} Stats` + '</h3>';
    if (statsType === 'User') {
        html += createStatBlock(t`Chatting Since`, `${chatAge} ago`);
    } else {
        html += createStatBlock(t`First Interaction`, `${chatAge} ago`);
    }
    html += createStatBlock(t`Chat Time`, timeStirng);
    html += createStatBlock(t`User Messages`, stats.user_msg_count);
    html += createStatBlock(
        t`Character Messages`,
        stats.non_user_msg_count - stats.total_swipe_count,
    );
    html += createStatBlock(t`User Words`, stats.user_word_count);
    html += createStatBlock(t`Character Words`, stats.non_user_word_count);
    html += createStatBlock(t`Swipes`, stats.total_swipe_count);

    return callGenericPopup(html, POPUP_TYPE.TEXT);
}

/**
 * Handles the user stats by getting them from the server, calculating the total and generating the HTML report.
 */
async function userStatsHandler() {
    // Get stats from server
    await getStats();

    // Calculate total stats
    let totalStats = calculateTotalStats();

    // Create HTML with stats
    createHtml('User', totalStats);
}

/**
 * Handles the character stats by getting them from the server and generating the HTML report.
 *
 * @param {Character} character - The character to show stats for.
 */
async function characterStatsHandler(character) {
    // Get stats from server
    await getStats();
    // Get character stats
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
 * Fetches the character stats from the server.
 */
async function getStats() {
    const response = await fetch('/api/stats/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
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
        toastr.error('Stats could not be loaded. Try reloading the page.');
        throw new Error('Error getting stats');
    } else {
        toastr.success('Stats file recreated successfully!');
    }
}


/**
 * Calculates the generation time based on start and finish times.
 *
 * @param {string} gen_started - The start time in ISO 8601 format.
 * @param {string} gen_finished - The finish time in ISO 8601 format.
 * @returns {number} - The difference in time in milliseconds.
 */
function calculateGenTime(gen_started, gen_finished) {
    if (gen_started === undefined || gen_finished === undefined) {
        return 0;
    }
    let startDate = new Date(gen_started);
    let endDate = new Date(gen_finished);
    return endDate.getTime() - startDate.getTime();
}

/**
 * Handles stat processing for messages.
 *
 * @param {Object} line - Object containing message data.
 * @param {string} type - The type of the message processing (e.g., 'append', 'continue', 'appendFinal', 'swipe').
 * @param {Character} character - The character the message belongs to.
 * @param {string} oldMessage - The old message that's being processed.
 */
/**
 * @param {Object} line - Object containing message data.
 * @param {string} type - The type of the message processing (e.g., 'append', 'continue', 'appendFinal', 'swipe').
 * @param {Character} character - The character the message belongs to.
 * @param {string} oldMessage - The old message that's being processed.
 */
async function statMesProcess(line, type, character, oldMessage) {
    if (character === undefined) {
        return;
    }

    // Deltas only - no GET-the-whole-blob-first needed, the server already holds the
    // authoritative running totals in memory and applies these in place. Every path below adds
    // to exactly one of these fields; only one of user_msg_count/non_user_msg_count/
    // total_swipe_count actually moves per call. Word counts are NOT computed here - the raw
    // text is sent in `wordCount` below and the server derives the word-count delta itself (see
    // countWordsInString() in src/endpoints/stats.js), since the server already owns the final
    // persisted message text and re-deriving the count client-side would just be duplicating
    // work the server can do authoritatively.
    //
    // gen-time IS still computed here from the client-recorded gen_started/gen_finished
    // timestamps - this genuinely differs from the word-count/dates cases: those client values
    // were pure re-derivations of data the server already has/owns, but gen_started/gen_finished
    // mark when THIS CLIENT dispatched its request and when it finished receiving the response,
    // which is the accurate end-to-end latency from the user's perspective. A server-side timestamp
    // of only its own backend call (even where one exists, e.g. some raw-action generation paths)
    // would be a narrower, less meaningful measurement - it would exclude network/queueing time -
    // not a more correct one, so this is intentionally left client-computed.
    const deltas = {
        total_gen_time: calculateGenTime(line.gen_started, line.gen_finished),
        user_msg_count: 0,
        non_user_msg_count: 0,
        total_swipe_count: 0,
    };

    const isEdit = type === 'append' || type === 'continue' || type === 'appendFinal';

    if (line.is_user) {
        if (!isEdit) {
            deltas.user_msg_count++;
        }
    } else {
        if (!isEdit) {
            deltas.non_user_msg_count++;
        }
    }

    if (type === 'swipe') {
        deltas.total_swipe_count++;
    }

    // Raw text (and, for edits, the prior text) for the server to derive the word-count delta
    // from itself - no client-side word counting. `dates` are no longer sent at all: the server
    // now stamps date_last_chat/date_first_chat from its own clock (see /api/stats/increment),
    // the same precedent already used for date_last_chat elsewhere (bumpCharacterDateLastChat()
    // in src/character-metadata-db.js), so a spoofed/incorrect client clock can no longer affect
    // stored stats.
    const wordCount = {
        is_user: !!line.is_user,
        text: line.mes,
        is_edit: isEdit,
        old_text: isEdit ? oldMessage : undefined,
    };

    const stat = await incrementStats(character.avatar, deltas, wordCount);
    if (stat) {
        charStats[character.avatar] = stat;
    }
}

/**
 * Sends one character's stat deltas to the server in a single request and returns the
 * server's own confirmed resulting stat object (or null on failure). Word-count deltas are
 * derived server-side from `wordCount`'s raw text (see /api/stats/increment) rather than being
 * pre-computed here; `date_last_chat`/`date_first_chat` are stamped from the server's own clock.
 * @param {string} avatar
 * @param {Object} deltas
 * @param {{is_user: boolean, text: string, is_edit: boolean, old_text: (string|undefined)}} wordCount
 * @returns {Promise<Object|null>}
 */
async function incrementStats(avatar, deltas, wordCount) {
    try {
        const response = await fetch('/api/stats/increment', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar, deltas, wordCount }),
        });
        if (!response.ok) {
            console.error('Failed to increment stats', response.status);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error('Failed to increment stats', error);
        return null;
    }
}

export function initStats() {
    $('.rm_stats_button').on('click', function () {
        characterStatsHandler(getCurrentCharacter());
    });
    registerDebugFunction('refreshStats', 'Refresh Stat File', 'Recreates the stats file based on existing chat files', recreateStats);
}

export { userStatsHandler, characterStatsHandler, getStats, statMesProcess, charStats };
