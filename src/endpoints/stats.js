import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getAllUserHandles, getUserDirectories } from '../users.js';
import { requestStore } from '../user-stores.js';
import { TYPE } from '../library-engine.js';

const STATS_FILE = 'stats.json';
/** The stats file as it was before the stats were derived from stored messages, kept and never written again. */
export const STATS_BACKUP_FILE = 'stats.pre-derived.json';
/** Upstream's date_first_chat for a character with no chats. */
const NO_FIRST_CHAT = new Date('9999-12-31T23:59:59.999Z').getTime();
/** At most this many characters are answered by one /get. */
const GET_LIMIT = 1000;

/**
 * Keeps a user's old stats file as `stats.pre-derived.json`, once: an existing backup is never written again.
 * @param {string} root The user's data root.
 */
export function keepOldStatsFile(root) {
    const from = path.join(root, STATS_FILE);
    const to = path.join(root, STATS_BACKUP_FILE);
    if (!fs.existsSync(from) || fs.existsSync(to)) return;
    try {
        fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    } catch (error) {
        if (error?.code !== 'EEXIST') console.error(`Could not keep the old stats file of ${root} as ${STATS_BACKUP_FILE}:`, error);
    }
}

/**
 * Keeps every user's old stats file (see keepOldStatsFile()).
 */
export async function init() {
    try {
        for (const handle of await getAllUserHandles()) {
            keepOldStatsFile(getUserDirectories(handle).root);
        }
    } catch (error) {
        console.error('Could not keep the old stats files:', error);
    }
}

/** Nothing to save: the stats are counted in the store as messages are written. */
export async function onExit() { }

/**
 * @typedef {{ userMsgs: number, charMsgs: number, userWords: number, charWords: number, swipes: number, genMs: number, genUnknown: number, chatSize: number, firstUserAt: number | null, lastAt: number | null }} ChatStats
 * A character's (or every chat's) stats as the store counts them (`chatRead('stats')`).
 */

/** No messages. */
const NO_STATS = { userMsgs: 0, charMsgs: 0, userWords: 0, charWords: 0, swipes: 0, genMs: 0, genUnknown: 0, chatSize: 0, firstUserAt: null, lastAt: null };

/**
 * Message stats in upstream's per-character shape.
 * @param {ChatStats} stats
 */
function upstreamShape(stats) {
    return {
        total_gen_time: stats.genMs,
        user_word_count: stats.userWords,
        non_user_word_count: stats.charWords,
        user_msg_count: stats.userMsgs,
        non_user_msg_count: stats.charMsgs,
        total_swipe_count: stats.swipes,
        chat_size: stats.chatSize,
        date_last_chat: stats.lastAt ?? 0,
        date_first_chat: stats.firstUserAt ?? NO_FIRST_CHAT,
        gen_time_unknown_count: stats.genUnknown,
    };
}

/**
 * Upstream's stats object for these characters: one entry per avatar a character has, plus `timestamp`.
 * @param {import('express').Request} request
 * @param {string[]} avatars
 */
async function statsFor(request, avatars) {
    const { lib } = await requestStore(request);
    const ids = await lib.ids(TYPE.character, avatars);
    const present = /** @type {bigint[]} */ (ids.filter(id => id !== null));
    const { owners } = present.length ? await lib.store.chatRead('stats', { owners: present }) : { owners: [] };
    /** @type {Record<string, any>} */
    const result = { timestamp: Date.now() };
    let at = 0;
    ids.forEach((id, i) => {
        if (id !== null) result[avatars[i]] = upstreamShape(owners[at++] ?? NO_STATS);
    });
    return result;
}

export const router = express.Router();

/**
 * The stats of the characters named in `avatars`, or, with none named, of up to 1000 characters with any messages
 * (the most recently chatted first), each in upstream's per-character shape. Counted from the stored messages.
 */
router.post('/get', async function (request, response) {
    try {
        const asked = request.body?.avatars;
        let avatars;
        if (Array.isArray(asked)) {
            avatars = asked.filter(a => typeof a === 'string' && a).slice(0, GET_LIMIT);
        } else {
            const { lib } = await requestStore(request);
            const page = await lib.query({
                sortField: 'date_last_chat', sortOrder: 'desc', ranges: { date_last_chat: { min: 1 } }, limit: GET_LIMIT,
                wantRows: false, wantTotal: false, wantHashes: true, includeGroups: false,
            });
            avatars = /** @type {{ id: string }[]} */ (page.hashRows).map(r => r.id);
        }
        return response.send(await statsFor(request, avatars));
    } catch (error) {
        console.error('Could not read the stats:', error);
        return response.sendStatus(500);
    }
});

/**
 * The user's totals over every chat (`filled`: always, as they are counted at every write), and the old stats file
 * kept from before the stats were counted from messages, if there is one.
 */
router.post('/totals', async function (request, response) {
    try {
        const { lib } = await requestStore(request);
        const { totals } = await lib.store.chatRead('stats', { owners: [] });
        const backupExists = fs.existsSync(path.join(request.user.directories.root, STATS_BACKUP_FILE));
        return response.send({
            stats: { ...upstreamShape(totals), chat_size: 0, date_last_chat: 0 },
            filled: true,
            backup: backupExists ? STATS_BACKUP_FILE : null,
        });
    } catch (error) {
        console.error('Could not read the stats totals:', error);
        return response.sendStatus(500);
    }
});

/**
 * Upstream's recount: the stats are exact at every write, so there is nothing to count again.
 */
router.post('/recreate', function (_request, response) {
    return response.sendStatus(200);
});

/**
 * Accepted for upstream callers and ignored: the stats are counted from the stored messages.
 */
router.post('/update', function (request, response) {
    if (!request.body) return response.sendStatus(400);
    return response.sendStatus(200);
});

/**
 * Accepted for upstream callers and ignored: the stats are counted from the stored messages. Answers the
 * character's current stats, as upstream answered the stats after the increment.
 */
router.post('/increment', async function (request, response) {
    const { avatar, deltas } = request.body ?? {};
    if (typeof avatar !== 'string' || !avatar || typeof deltas !== 'object' || deltas === null) {
        return response.sendStatus(400);
    }
    try {
        const stats = await statsFor(request, [avatar]);
        return response.send(stats[avatar] ?? upstreamShape(NO_STATS));
    } catch (error) {
        console.error('Could not read the stats:', error);
        return response.sendStatus(500);
    }
});
