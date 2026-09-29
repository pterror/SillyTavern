#!/usr/bin/env node
/**
 * Read-only corpus stats CLI. Safe to run against a live server: opened through the engine's
 * `{ readonly: true }` mode, which can read a WAL-mode database without blocking the live read-write
 * connection.
 *
 * Usage:
 *   node scripts/stats.js
 *   node scripts/stats.js --data-root ./data/some-other-user
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openNativeDatabase } from '../src/endpoints/sqlite-engine.js';

// better-sqlite3's own default; the engine's longer default is sized for the server's bulk write passes.
const BUSY_TIMEOUT_MS = 5000;
const TOP_N = 10;

function getArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatDate(epochMs) {
    if (!epochMs) return '(never)';
    return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function line(label, value, labelWidth = 28) {
    return `  ${label.padEnd(labelWidth)} ${value}`;
}

function heading(title) {
    console.log('');
    console.log(title);
    console.log('-'.repeat(title.length));
}

function table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
    const renderRow = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
    console.log(renderRow(headers));
    console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
    for (const row of rows) {
        console.log(renderRow(row));
    }
}

function tryOpen(dbPath, label) {
    if (!fs.existsSync(dbPath)) {
        console.warn(`warning: ${label} not found at ${dbPath} - skipping its section(s)`);
        return null;
    }
    try {
        return openNativeDatabase(Database, dbPath, { readonly: true, busyTimeoutMs: BUSY_TIMEOUT_MS });
    } catch (error) {
        console.warn(`warning: couldn't open ${label} (${dbPath}): ${error.message} - skipping its section(s)`);
        return null;
    }
}

function main() {
    const args = process.argv.slice(2);
    const dataRoot = path.resolve(getArg(args, 'data-root', './data/default-user'));

    console.log(`SillyTavern corpus stats - data root: ${dataRoot}`);

    const charDb = tryOpen(path.join(dataRoot, 'character-metadata.sqlite'), 'character-metadata.sqlite');
    const treeDb = tryOpen(path.join(dataRoot, 'message-tree.sqlite'), 'message-tree.sqlite');

    // ---------------------------------------------------------------------
    // Overview
    // ---------------------------------------------------------------------
    heading('Overview');

    if (charDb) {
        const { count: totalCharacters } = charDb.get('SELECT COUNT(*) AS count FROM characters');
        const { count: totalGroups } = charDb.get('SELECT COUNT(*) AS count FROM groups');
        const { count: totalFavCharacters } = charDb.get('SELECT COUNT(*) AS count FROM characters WHERE fav = 1');
        const { count: totalFavGroups } = charDb.get('SELECT COUNT(*) AS count FROM groups WHERE fav = 1');
        const { count: totalTags } = charDb.get('SELECT COUNT(*) AS count FROM tags');
        const { count: characterTagAssignments } = charDb.get('SELECT COUNT(*) AS count FROM character_tags');
        const { count: groupTagAssignments } = charDb.get('SELECT COUNT(*) AS count FROM group_tags');
        const totalTagAssignments = characterTagAssignments + groupTagAssignments;
        const { total: totalDataSize } = charDb.get('SELECT COALESCE(SUM(data_size), 0) AS total FROM characters');
        const { total: totalChatSizeChars } = charDb.get('SELECT COALESCE(SUM(chat_size), 0) AS total FROM characters');
        const { total: totalChatSizeGroups } = charDb.get('SELECT COALESCE(SUM(chat_size), 0) AS total FROM groups');

        console.log(line('Total characters:', totalCharacters));
        console.log(line('Total groups:', totalGroups));
        console.log(line('Total favorites:', `${totalFavCharacters} characters, ${totalFavGroups} groups`));
        console.log(line('Total tags:', totalTags));
        console.log(line('Total tag assignments:', totalTagAssignments));
        console.log(line('Total data size:', formatBytes(totalDataSize)));
        console.log(line('Total chat size (characters):', formatBytes(totalChatSizeChars)));
        console.log(line('Total chat size (groups):', formatBytes(totalChatSizeGroups)));
    }

    if (treeDb) {
        const { count: totalBranches } = treeDb.get('SELECT COUNT(*) AS count FROM branches');
        const { count: totalMessages } = treeDb.get('SELECT COUNT(*) AS count FROM messages');
        console.log(line('Total branches (chats):', totalBranches));
        console.log(line('Total messages:', totalMessages));
    }

    // ---------------------------------------------------------------------
    // Top tags by usage
    // ---------------------------------------------------------------------
    if (charDb) {
        heading(`Top ${TOP_N} tags by usage`);
        const topTags = charDb.readBounded(`
            SELECT t.id, t.data, u.count
            FROM tag_usage u
            JOIN tags t ON t.id = u.tag_id
            WHERE u.count > 0
            ORDER BY u.count DESC
            LIMIT @limit
        `, { limit: TOP_N }, TOP_N);
        if (topTags.length === 0) {
            console.log('  (no tag usage recorded)');
        } else {
            table(
                ['Tag', 'Uses'],
                topTags.map(row => {
                    let name = row.id;
                    try {
                        name = JSON.parse(row.data).name ?? row.id;
                    } catch {
                        // Malformed tag JSON - fall back to the raw id rather than failing the whole report.
                    }
                    return [name, String(row.count)];
                }),
            );
        }
    }

    // ---------------------------------------------------------------------
    // Recent activity
    // ---------------------------------------------------------------------
    if (charDb) {
        heading(`${TOP_N} most recently added characters`);
        const recentlyAdded = charDb.readBounded(`
            SELECT name_fold, date_added FROM characters
            ORDER BY date_added DESC
            LIMIT @limit
        `, { limit: TOP_N }, TOP_N);
        table(
            ['Name', 'Date added'],
            recentlyAdded.map(r => [r.name_fold, formatDate(r.date_added)]),
        );

        heading(`${TOP_N} most recently chatted characters`);
        const recentlyChatted = charDb.readBounded(`
            SELECT name_fold, date_last_chat FROM characters
            WHERE date_last_chat IS NOT NULL AND date_last_chat > 0
            ORDER BY date_last_chat DESC
            LIMIT @limit
        `, { limit: TOP_N }, TOP_N);
        if (recentlyChatted.length === 0) {
            console.log('  (no chat activity recorded)');
        } else {
            table(
                ['Name', 'Date last chat'],
                recentlyChatted.map(r => [r.name_fold, formatDate(r.date_last_chat)]),
            );
        }
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    if (charDb) {
        heading(`Top ${TOP_N} characters by data size`);
        const byDataSize = charDb.readBounded(`
            SELECT name_fold, data_size FROM characters
            ORDER BY data_size DESC
            LIMIT @limit
        `, { limit: TOP_N }, TOP_N);
        table(
            ['Name', 'Data size'],
            byDataSize.map(r => [r.name_fold, formatBytes(r.data_size)]),
        );

        heading(`Top ${TOP_N} characters by chat size`);
        const byChatSize = charDb.readBounded(`
            SELECT name_fold, chat_size FROM characters
            ORDER BY chat_size DESC
            LIMIT @limit
        `, { limit: TOP_N }, TOP_N);
        table(
            ['Name', 'Chat size'],
            byChatSize.map(r => [r.name_fold, formatBytes(r.chat_size)]),
        );
    }

    console.log('');

    charDb?.close();
    treeDb?.close();
}

main();
