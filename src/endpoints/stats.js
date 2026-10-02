import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getAllUserHandles, getUserDirectories } from '../users.js';
import { characterOwnerIdOf, listCharacterStatOwners, readMessageStats, restartMessageStatsFill } from '../message-tree-db.js';
import { getCharacterChatStats } from '../character-metadata-db.js';
import { requestMetadataMigrationPass } from '../metadata-migration-coordinator.js';

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

/** Nothing to save: the stats are counted in the message store as messages are written. */
export async function onExit() { }

/**
 * Message stats in upstream's per-character shape.
 * @param {import('../message-stats.js').MessageStats} stats
 * @param {{ chatSize: number, dateLastChat: number } | null} chat
 */
function upstreamShape(stats, chat) {
    return {
        total_gen_time: stats.gen_ms,
        user_word_count: stats.user_words,
        non_user_word_count: stats.char_words,
        user_msg_count: stats.user_msgs,
        non_user_msg_count: stats.char_msgs,
        total_swipe_count: stats.swipes,
        chat_size: chat?.chatSize ?? 0,
        date_last_chat: chat?.dateLastChat ?? 0,
        date_first_chat: stats.first_user_at ?? NO_FIRST_CHAT,
        gen_time_unknown_count: stats.gen_unknown,
    };
}

/**
 * Upstream's stats object for these characters: one entry per avatar, plus `timestamp`.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string[]} avatars
 */
async function statsFor(directories, avatars) {
    const ownerIds = avatars.map(characterOwnerIdOf);
    const read = await readMessageStats(directories, ownerIds);
    /** @type {Record<string, any>} */
    const result = { timestamp: Date.now() };
    if (!read) return result;
    for (let i = 0; i < avatars.length; i++) {
        const stats = read.owners.get(ownerIds[i]);
        if (stats) result[avatars[i]] = upstreamShape(stats, await getCharacterChatStats(directories, avatars[i]));
    }
    return result;
}

export const router = express.Router();

/**
 * The stats of the characters named in `avatars`, or, with none named, of up to the first 1000 characters with any
 * messages (in owner id order), each in upstream's per-character shape. Counted from the stored messages.
 */
router.post('/get', async function (request, response) {
    try {
        const asked = request.body?.avatars;
        let avatars;
        if (Array.isArray(asked)) {
            avatars = asked.filter(a => typeof a === 'string' && a).slice(0, GET_LIMIT);
        } else {
            avatars = (await listCharacterStatOwners(request.user.directories, GET_LIMIT)).map(o => o.avatar);
        }
        return response.send(await statsFor(request.user.directories, avatars));
    } catch (error) {
        console.error('Could not read the stats:', error);
        return response.sendStatus(500);
    }
});

/**
 * The user's totals over every chat, whether the first count of the stored chats has finished, and the old stats
 * file kept from before the stats were counted from messages, if there is one.
 */
router.post('/totals', async function (request, response) {
    try {
        const read = await readMessageStats(request.user.directories, []);
        if (!read) return response.sendStatus(503);
        const backupExists = fs.existsSync(path.join(request.user.directories.root, STATS_BACKUP_FILE));
        return response.send({
            stats: upstreamShape(read.totals, null),
            filled: read.filled,
            backup: backupExists ? STATS_BACKUP_FILE : null,
        });
    } catch (error) {
        console.error('Could not read the stats totals:', error);
        return response.sendStatus(500);
    }
});

/**
 * Counts every stored chat again from its messages, in the background.
 */
router.post('/recreate', async function (request, response) {
    try {
        await restartMessageStatsFill(request.user.directories);
        requestMetadataMigrationPass(request.user.directories, 'fillMessageStatsIfNeeded');
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
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
        const stats = await statsFor(request.user.directories, [avatar]);
        return response.send(stats[avatar] ?? upstreamShape({ user_msgs: 0, char_msgs: 0, user_words: 0, char_words: 0, swipes: 0, gen_ms: 0, gen_unknown: 0, first_user_at: null }, null));
    } catch (error) {
        console.error('Could not read the stats:', error);
        return response.sendStatus(500);
    }
});
