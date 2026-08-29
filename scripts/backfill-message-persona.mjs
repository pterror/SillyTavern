/**
 * Stamps the persona onto user messages written before the field existed.
 *
 * A user message's speaker is the persona it was said as. Messages written before that was recorded
 * carry only a display name, and an absent persona is not a distinct speaker - it is a row written
 * before the column existed. Left alone, every one of them would stop matching new messages carrying
 * the same text and persona, producing duplicate siblings from the cutover onward.
 *
 * The mapping is name -> persona, taken from the user's own persona list, and only where a name
 * belongs to exactly one persona. A name matching none, or more than one, is left untouched and
 * reported: better a row that keeps its old identity than one assigned the wrong speaker.
 *
 * Only ever adds the field. Never edits text, never changes an existing persona, never touches a
 * character message.
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
