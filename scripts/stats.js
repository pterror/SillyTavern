#!/usr/bin/env node
/**
 * Corpus stats CLI: read-only, through a running server's routes (it opens no store and reads no data file).
 *
 * Usage:
 *   node scripts/stats.js --url http://127.0.0.1:8000
 */

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

/**
 * A session on the server, as the page gets one: its CSRF token and cookie.
 * @param {string} base
 */
async function openSession(base) {
    const res = await fetch(`${base}/csrf-token`);
    if (!res.ok) throw new Error(`${base}/csrf-token answered ${res.status}`);
    const { token } = await res.json();
    const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    return { base, token, cookie };
}

/**
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {string} route
 * @param {object} body
 */
async function post(session, route, body) {
    const res = await fetch(`${session.base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.token, Cookie: session.cookie },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${route} answered ${res.status}: ${await res.text()}`);
    return res.json();
}

/**
 * A `/query` page of characters (and groups, with `includeGroups`) in JSON.
 * @param {{ base: string, token: string, cookie: string }} session
 * @param {object} filter
 * @param {{ field: string, order: string }} sort
 * @param {number} pageSize
 */
function query(session, filter, sort, pageSize) {
    return post(session, '/api/characters/query', { filter, sort, page: 1, pageSize, want: ['rows', 'total'] });
}

/** A total as `/query` answers it: marked "~" when it is an estimate. */
const totalOf = page => `${page.total}${page.approxTotal ? ' (~)' : ''}`;

async function main() {
    const args = process.argv.slice(2);
    const url = getArg(args, 'url', null);
    if (url === null) {
        console.error('usage: node scripts/stats.js --url <the running server, e.g. http://127.0.0.1:8000>');
        process.exitCode = 2;
        return;
    }
    const session = await openSession(url.replace(/\/+$/, ''));
    console.log(`SillyTavern corpus stats - server: ${session.base}`);

    heading('Totals');
    const nameAsc = { field: 'name', order: 'asc' };
    const characters = await query(session, {}, nameAsc, 1);
    const both = await query(session, { includeGroups: true }, nameAsc, 1);
    const favCharacters = await query(session, { fav: true }, nameAsc, 1);
    const favBoth = await query(session, { fav: true, includeGroups: true }, nameAsc, 1);
    console.log(line('Total characters:', totalOf(characters)));
    console.log(line('Total groups:', both.approxTotal || characters.approxTotal ? `~${both.total - characters.total}` : both.total - characters.total));
    console.log(line('Total favorites:', `${totalOf(favCharacters)} characters, ${favBoth.total - favCharacters.total} groups`));
    const { stats } = await post(session, '/api/stats/totals', {});
    console.log(line('Messages counted:', `${stats.user_msg_count} user, ${stats.non_user_msg_count} character`));

    heading(`Top ${TOP_N} tags by usage`);
    const tags = await post(session, '/api/tags/query', { filter: { used: true }, sort: { field: 'by_entries' }, pageSize: TOP_N, counts: true });
    if (tags.rows.length === 0) {
        console.log('  (no tag usage recorded)');
    } else {
        table(['Tag', 'Uses'], tags.rows.map(row => [row.name ?? row.id, String(tags.counts?.[row.id] ?? '-')]));
    }

    heading(`${TOP_N} most recently added characters`);
    const added = await query(session, {}, { field: 'date_added', order: 'desc' }, TOP_N);
    table(['Name', 'Date added'], added.rows.map(r => [r.name, formatDate(r.date_added)]));

    heading(`${TOP_N} most recently chatted characters`);
    const chatted = (await query(session, {}, { field: 'date_last_chat', order: 'desc' }, TOP_N)).rows.filter(r => r.date_last_chat > 0);
    if (chatted.length === 0) {
        console.log('  (no chat activity recorded)');
    } else {
        table(['Name', 'Date last chat'], chatted.map(r => [r.name, formatDate(r.date_last_chat)]));
    }

    heading(`Top ${TOP_N} characters by data size`);
    const byData = await query(session, {}, { field: 'data_size', order: 'desc' }, TOP_N);
    table(['Name', 'Data size'], byData.rows.map(r => [r.name, formatBytes(r.data_size)]));

    heading(`Top ${TOP_N} characters by chat size`);
    const byChat = await query(session, {}, { field: 'chat_size', order: 'desc' }, TOP_N);
    table(['Name', 'Chat size'], byChat.rows.map(r => [r.name, formatBytes(r.chat_size)]));

    console.log('');
}

await main();
