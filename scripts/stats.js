#!/usr/bin/env node
/**
 * Standalone corpus stats CLI - reads character-metadata.sqlite and message-tree.sqlite directly and prints an
 * overview (counts, top tags, recent activity, storage). No write path, no server bootstrap - just SELECTs
 * against the two per-user databases, so it's safe to run against a live install (see the readonly note below)
 * and cheap even against a very large corpus, since every query here rides an index already declared by
 * character-metadata-db.js / message-tree-db.js's own SCHEMA_SQL (name_fold, date_added, date_last_chat,
 * data_size, chat_size, tag_usage's own PK, branches(owner_id)) rather than scanning a table cold.
 *
 * Opened with `{ readonly: true }` (better-sqlite3), deliberately NOT the `db.pragma('journal_mode = WAL')` +
 * read-write open that sqlite-engine.js's native adapter uses for the live server connection - this script has
 * no business ever writing to either database, and a readonly SQLITE_OPEN_READONLY connection can read a
 * WAL-mode database (including whatever's currently sitting in the -wal file) just fine without taking any lock
 * the live server's own read-write connection would contend with. That's the actual mechanism that makes this
 * safe to run against a server that's already up: readers never block writers and writers never block readers
 * in WAL mode, they just each see a consistent snapshot as of when their own read transaction started.
 *
 * Usage:
 *   node scripts/stats.js
 *   node scripts/stats.js --data-root ./data/some-other-user
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function getArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
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

/**
 * @param {number} epochMs
 * @returns {string}
 */
function formatDate(epochMs) {
    if (!epochMs) return '(never)';
    return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

/** Right-pads a label and right-aligns a value, for the two-column "key: value" overview lines. */
function line(label, value, labelWidth = 28) {
    return `  ${label.padEnd(labelWidth)} ${value}`;
}

function heading(title) {
    console.log('');
    console.log(title);
    console.log('-'.repeat(title.length));
}

/**
 * Renders a simple aligned table: an array of column arrays (already stringified), each padded to that column's
 * own max width. No external formatting library - just console.log with padding, per the ask.
 * @param {string[]} headers
 * @param {string[][]} rows
 */
function table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)));
    const renderRow = (cells) => '  ' + cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
    console.log(renderRow(headers));
    console.log('  ' + widths.map(w => '-'.repeat(w)).join('  '));
    for (const row of rows) {
        console.log(renderRow(row));
    }
}

/**
 * Opens a database readonly, or returns null (with a printed warning) if the file doesn't exist / can't be
 * opened - so a missing database degrades to "skip that section" rather than crashing the whole report.
 * @param {string} dbPath
 * @param {string} label
 * @returns {import('better-sqlite3').Database | null}
 */
function tryOpen(dbPath, label) {
    if (!fs.existsSync(dbPath)) {
        console.warn(`warning: ${label} not found at ${dbPath} - skipping its section(s)`);
        return null;
    }
    try {
        return new Database(dbPath, { readonly: true, fileMustExist: true });
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
        const { count: totalCharacters } = charDb.prepare('SELECT COUNT(*) AS count FROM characters').get();
        const { count: totalGroups } = charDb.prepare('SELECT COUNT(*) AS count FROM groups').get();
        const { count: totalFavCharacters } = charDb.prepare('SELECT COUNT(*) AS count FROM characters WHERE fav = 1').get();
        const { count: totalFavGroups } = charDb.prepare('SELECT COUNT(*) AS count FROM groups WHERE fav = 1').get();
        const { count: totalTags } = charDb.prepare('SELECT COUNT(*) AS count FROM tags').get();
        const { count: characterTagAssignments } = charDb.prepare('SELECT COUNT(*) AS count FROM character_tags').get();
        const { count: groupTagAssignments } = charDb.prepare('SELECT COUNT(*) AS count FROM group_tags').get();
        const totalTagAssignments = characterTagAssignments + groupTagAssignments;
        const { total: totalDataSize } = charDb.prepare('SELECT COALESCE(SUM(data_size), 0) AS total FROM characters').get();
        const { total: totalChatSizeChars } = charDb.prepare('SELECT COALESCE(SUM(chat_size), 0) AS total FROM characters').get();
        const { total: totalChatSizeGroups } = charDb.prepare('SELECT COALESCE(SUM(chat_size), 0) AS total FROM groups').get();

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
        const { count: totalBranches } = treeDb.prepare('SELECT COUNT(*) AS count FROM branches').get();
        const { count: totalMessages } = treeDb.prepare('SELECT COUNT(*) AS count FROM messages').get();
        console.log(line('Total branches (chats):', totalBranches));
        console.log(line('Total messages:', totalMessages));
    }

    // ---------------------------------------------------------------------
    // Top tags by usage
    // ---------------------------------------------------------------------
    if (charDb) {
        heading('Top 10 tags by usage');
        const topTags = charDb.prepare(`
            SELECT t.id, t.data, u.count
            FROM tag_usage u
            JOIN tags t ON t.id = u.tag_id
            WHERE u.count > 0
            ORDER BY u.count DESC
            LIMIT 10
        `).all();
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
        heading('10 most recently added characters');
        const recentlyAdded = charDb.prepare(`
            SELECT name_fold, date_added FROM characters
            ORDER BY date_added DESC
            LIMIT 10
        `).all();
        table(
            ['Name', 'Date added'],
            recentlyAdded.map(r => [r.name_fold, formatDate(r.date_added)]),
        );

        heading('10 most recently chatted characters');
        const recentlyChatted = charDb.prepare(`
            SELECT name_fold, date_last_chat FROM characters
            WHERE date_last_chat IS NOT NULL AND date_last_chat > 0
            ORDER BY date_last_chat DESC
            LIMIT 10
        `).all();
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
        heading('Top 10 characters by data size');
        const byDataSize = charDb.prepare(`
            SELECT name_fold, data_size FROM characters
            ORDER BY data_size DESC
            LIMIT 10
        `).all();
        table(
            ['Name', 'Data size'],
            byDataSize.map(r => [r.name_fold, formatBytes(r.data_size)]),
        );

        heading('Top 10 characters by chat size');
        const byChatSize = charDb.prepare(`
            SELECT name_fold, chat_size FROM characters
            ORDER BY chat_size DESC
            LIMIT 10
        `).all();
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
