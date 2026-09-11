/**
 * Restores alternative rows whose text was blanked by the hole-to-empty-string bug: a windowed chat
 * load sends unloaded alternatives as `null`, `ensureSwipes` on the client "repaired" that to `''`,
 * and the save wrote that emptiness over the stored text.
 *
 * Source of truth is a reference database produced by the same migration from the same source data.
 * Matching isn't by row id alone: the migration mints fresh uuids for non-selected alternatives, so
 * parents are matched by id (or by owner for anchors), and children are then matched by ordinal under
 * the (created_at, id) ordering this schema uses everywhere.
 *
 * Only ever writes text into an empty row; never overwrites, inserts, or deletes. If a parent's child
 * count disagrees between the two databases the ordinals can't be trusted, so it's skipped.
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
