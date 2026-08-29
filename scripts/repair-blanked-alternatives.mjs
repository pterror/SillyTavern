/**
 * Restores alternative rows whose text was blanked by the hole-to-empty-string bug.
 *
 * A windowed chat load sends unloaded alternatives as `null` holes. `ensureSwipes` on the client
 * treated a non-string swipe as corruption and "repaired" it to `''`; the save then wrote that
 * emptiness over the stored text, slot by slot. This puts the text back.
 *
 * Source of truth is a reference database produced by the same migration from the same source data,
 * so every row it holds is a row this database is supposed to have.
 *
 * Matching, and why it isn't just row id: the migration keeps a source row's id for its SELECTED
 * alternative but mints fresh uuids for the others, so two runs agree on ids for most rows but not
 * all, and anchors differ every time. So parents are matched by id where possible and by owner for
 * anchors, and their children are then matched by ORDINAL under the (created_at, id) ordering this
 * schema uses everywhere.
 *
 * Only ever writes text INTO an empty row. Never overwrites text, never inserts, never deletes. If a
 * parent's child count disagrees between the two databases the ordinals can't be trusted, so that
 * parent is skipped and reported rather than guessed at.
 *
 * Usage:
 *   node scripts/repair-blanked-alternatives.mjs <target.sqlite> <reference.sqlite> [--apply]
 *
 * Dry run by default. --apply writes.
 */

import fs from 'node:fs';
import Database from 'better-sqlite3';

function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const [targetPath, refPath] = args.filter(a => !a.startsWith('--'));

    if (!targetPath || !refPath) {
        console.error('usage: repair-blanked-alternatives.mjs <target.sqlite> <reference.sqlite> [--apply]');
        process.exit(2);
    }
    for (const p of [targetPath, refPath]) {
        if (!fs.existsSync(p)) {
            console.error(`not found: ${p}`);
            process.exit(2);
        }
    }

    const db = new Database(targetPath, { readonly: !apply });
    const ref = new Database(refPath, { readonly: true });

    const mesOf = (json) => {
        try { return JSON.parse(json)?.mes ?? ''; } catch { return ''; }
    };

    // Anchors get a fresh uuid on every migration run, so map them by owner instead of by id.
    const anchorMap = new Map();
    for (const a of db.prepare('SELECT id, owner_id FROM messages WHERE parent_id IS NULL').all()) {
        const r = ref.prepare('SELECT id FROM messages WHERE owner_id = ? AND parent_id IS NULL').get(a.owner_id);
        if (r) anchorMap.set(a.id, r.id);
    }

    // Every parent that currently has at least one blanked child.
    const parents = db.prepare(`
        SELECT DISTINCT parent_id AS id FROM messages
        WHERE parent_id IS NOT NULL AND length(coalesce(json_extract(content,'$.mes'),'')) = 0
    `).all().map(r => r.id);

    const kids = db.prepare('SELECT id, content FROM messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC');
    const refKids = ref.prepare('SELECT id, content FROM messages WHERE parent_id = ? ORDER BY created_at ASC, id ASC');
    const write = db.prepare('UPDATE messages SET content = @content WHERE id = @id');

    const stats = {
        parentsWithBlanks: parents.length,
        blankRows: 0,
        restorable: 0,
        skippedNoRefParent: 0,
        skippedCountMismatch: 0,
        skippedRefAlsoEmpty: 0,
        applied: 0,
    };
    /** @type {{id: string, content: string}[]} */
    const pending = [];

    for (const parentId of parents) {
        const mine = kids.all(parentId);
        stats.blankRows += mine.filter(k => mesOf(k.content).length === 0).length;

        const refParentId = anchorMap.get(parentId) ?? parentId;
        const theirs = refKids.all(refParentId);

        if (theirs.length === 0) { stats.skippedNoRefParent++; continue; }
        // Different child counts mean the ordinals don't line up and a positional match would put the
        // wrong text on the wrong row. Skipping loses nothing; guessing would corrupt.
        if (theirs.length !== mine.length) { stats.skippedCountMismatch++; continue; }

        for (let i = 0; i < mine.length; i++) {
            if (mesOf(mine[i].content).length > 0) continue;
            const theirText = mesOf(theirs[i].content);
            if (theirText.length === 0) { stats.skippedRefAlsoEmpty++; continue; }
            stats.restorable++;
            pending.push({ id: mine[i].id, content: theirs[i].content });
        }
    }

    if (apply) {
        db.transaction(() => {
            for (const p of pending) { write.run(p); stats.applied++; }
        })();
    }

    console.log(JSON.stringify(stats, null, 2));

    if (apply) {
        const left = db.prepare("SELECT count(*) c FROM messages WHERE parent_id IS NOT NULL AND length(coalesce(json_extract(content,'$.mes'),'')) = 0").get().c;
        console.log(`empty-mes rows remaining after repair: ${left}`);
    } else {
        console.log('(dry run - pass --apply to write)');
    }

    db.close();
    ref.close();
}

main();
