/**
 * Stamps the persona onto user messages written before the field existed, matching display name to
 * persona only where the name is unambiguous. Only ever adds the field; never touches character messages.
 *
 * Usage:
 *   node scripts/backfill-message-persona.mjs <db.sqlite> <settings.json> [--apply]
 *
 * Dry run by default.
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';

function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const [dbPath, settingsPath] = args.filter(a => !a.startsWith('--'));

    if (!dbPath || !settingsPath) {
        console.error('usage: backfill-message-persona.mjs <db.sqlite> <settings.json> [--apply]');
        process.exit(2);
    }
    for (const p of [dbPath, settingsPath]) {
        if (!fs.existsSync(p)) {
            console.error(`not found: ${p}`);
            process.exit(2);
        }
    }

    // name -> persona avatar id, only where the name belongs to exactly one persona
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const personas = settings?.power_user?.personas ?? {};
    const byName = new Map();
    for (const [avatarId, name] of Object.entries(personas)) {
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(avatarId);
    }
    const resolve = new Map();
    const ambiguous = [];
    for (const [name, ids] of byName) {
        if (ids.length === 1) resolve.set(name, ids[0]);
        else ambiguous.push({ name, ids });
    }

    const db = new Database(dbPath, { readonly: !apply });

    const rows = db.prepare(`
        SELECT id, content FROM messages
        WHERE json_extract(content, '$.is_user') = 1
          AND json_extract(content, '$.persona') IS NULL
    `).all();

    const write = db.prepare('UPDATE messages SET content = @content WHERE id = @id');

    const stats = { personas: Object.keys(personas).length, ambiguousNames: ambiguous, candidates: rows.length, resolved: 0, unresolved: 0, malformed: 0, applied: 0 };
    const byPersona = {};
    const unresolvedByName = {};
    const pending = [];

    for (const row of rows) {
        let msg;
        try {
            msg = JSON.parse(row.content);
        } catch {
            stats.malformed++;
            continue;
        }

        const avatarId = resolve.get(msg?.name);
        if (!avatarId) {
            stats.unresolved++;
            const key = String(msg?.name);
            unresolvedByName[key] = (unresolvedByName[key] ?? 0) + 1;
            continue;
        }

        stats.resolved++;
        byPersona[avatarId] = (byPersona[avatarId] ?? 0) + 1;
        // Add only. Everything else about the message stays byte-identical.
        msg.persona = avatarId;
        pending.push({ id: row.id, content: JSON.stringify(msg) });
    }

    if (apply) {
        db.transaction(() => {
            for (const p of pending) { write.run(p); stats.applied++; }
        })();
    }

    console.log(JSON.stringify({ ...stats, byPersona, unresolvedByName }, null, 2));
    if (!apply) console.log('(dry run - pass --apply to write)');
    db.close();
}

main();
