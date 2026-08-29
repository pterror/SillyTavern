/**
 * One-off migration of an existing message-tree.sqlite from the branches-table + swipe-array shape
 * to the single-table shape: messages(id, parent_id, owner_id, content, label, created_at,
 * default_child_id, metadata), no branches table, every alternative its own sibling row.
 *
 * Writes a brand new database file rather than mutating in place, so the source is never at risk.
 *
 * Usage:
 *   node scripts/migrate-tree-sibling-swipes.mjs <source.sqlite> <dest.sqlite> [--json-report path]
 *
 * Node identity is `(parent, speaker, mes)`, via the SAME nodeIdentityKey() every other ingest
 * path uses, so they cannot drift apart. The same words from the user and from the character are two
 * different messages. But two alternatives with the same speaker AND the same text under one parent
 * are one node — a differing send_date or token_count does not make them two things, because a token
 * count is a derived measurement of the text rather than part of what the message is. This
 * matters enormously on real data: one card here carries ~928 alternate greetings across 1,085 roots,
 * so the same greeting text recurs about 1,050 times and without text-identity the anchor fans out to
 * half a million children that are 99.9% repeats.
 *
 * Because deduping siblings can merge two source rows into one, a source row's children may need to
 * hang off a row that came from somewhere else entirely. So the tree is walked top-down (breadth-first
 * from each owner's roots) with a source-id -> dest-id map, and parents are always resolved before
 * their children. The selected alternative reuses its source row id wherever that id survives, which
 * keeps the common case free of remapping.
 *
 * Order of work:
 *  1. One synthetic anchor row per owner (parent_id IS NULL, inert content), uniformly, whatever the
 *     owner's root count is. Every existing root becomes a child of its owner's anchor.
 *  2. Top-down walk expanding every row into its alternatives, deduped on nodeIdentityKey().
 *     `swipe_info[i]`'s send_date/extra ride along onto alternative i — that is the only home a
 *     genuinely distinct alternative's send_date has left. Where `mes` disagreed with
 *     `swipes[swipe_id]`, `swipes[swipe_id]` wins.
 *  3. Each branch row becomes a `label` + `metadata` on its (remapped) leaf. Two branches on one leaf:
 *     the winner under (created_at ASC, id ASC) supplies BOTH the name and the metadata blob; losers
 *     are dropped and reported by name.
 *  4. `default_child_id` chains laid down by walking each labeled leaf back to its anchor, oldest
 *     branch first, so the newest chat through any fork is the one that fork shows.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import { alternativesFromMessage, ANCHOR_CONTENT, nodeIdentityKey } from '../src/message-tree-db.js';

const SCHEMA = `
    CREATE TABLE messages (
        id               TEXT PRIMARY KEY,
        parent_id        TEXT REFERENCES messages(id),
        owner_id         TEXT NOT NULL,
        content          TEXT NOT NULL,
        label            TEXT,
        created_at       INTEGER NOT NULL,
        default_child_id TEXT REFERENCES messages(id),
        metadata         TEXT
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

const INDEXES = `
    CREATE INDEX idx_messages_parent      ON messages(parent_id);
    CREATE INDEX idx_messages_owner       ON messages(owner_id);
    CREATE INDEX idx_messages_owner_label ON messages(owner_id, label) WHERE label IS NOT NULL;
    CREATE INDEX idx_messages_anchor      ON messages(owner_id) WHERE parent_id IS NULL;
`;

function main() {
    const [srcPath, dstPath] = process.argv.slice(2).filter(a => !a.startsWith('--'));
    const reportIdx = process.argv.indexOf('--json-report');
    const reportPath = reportIdx > -1 ? process.argv[reportIdx + 1] : null;

    if (!srcPath || !dstPath) {
        console.error('usage: migrate-tree-sibling-swipes.mjs <source.sqlite> <dest.sqlite> [--json-report path]');
        process.exit(2);
    }
    if (!fs.existsSync(srcPath)) {
        console.error(`source not found: ${srcPath}`);
        process.exit(2);
    }
    if (fs.existsSync(dstPath)) {
        console.error(`destination already exists, refusing to overwrite: ${dstPath}`);
        process.exit(2);
    }

    const t0 = Date.now();
    const src = new Database(srcPath, { readonly: true });
    const dst = new Database(dstPath);
    dst.pragma('journal_mode = OFF');
    dst.pragma('synchronous = OFF');
    dst.exec(SCHEMA);

    const report = {
        source: srcPath,
        dest: dstPath,
        identity: '(parent_id, speaker, mes) via shared nodeIdentityKey()',
        sourceMessages: src.prepare('SELECT count(*) c FROM messages').get().c,
        sourceBranches: src.prepare('SELECT count(*) c FROM branches').get().c,
        sourceSwipeTotal: src.prepare("SELECT sum(coalesce(json_array_length(json_extract(content,'$.swipes')),1)) s FROM messages").get().s,
        owners: 0,
        anchorsCreated: 0,
        rowsWritten: 0,
        alternativesMergedByText: 0,
        sourceRowsMergedIntoAnother: 0,
        sourceRowsUnreachable: 0,
        swipeIdClamped: 0,
        mesOverriddenBySwipe: 0,
        preexistingBookmarkLabels: 0,
        bookmarkLabelsOverwrittenByChatName: 0,
        droppedChatNames: [],
        labelsWritten: 0,
        defaultChildEdges: 0,
        errors: [],
    };

    const insert = dst.prepare(
        `INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata)
         VALUES (@id, @parent_id, @owner_id, @content, @label, @created_at, NULL, NULL)`,
    );

    // ---- phase 1: anchors -------------------------------------------------
    const owners = src.prepare('SELECT owner_id, min(created_at) mn FROM messages GROUP BY owner_id').all();
    report.owners = owners.length;
    /** @type {Map<string, string>} owner_id -> anchor row id */
    const anchorOf = new Map();

    dst.transaction(() => {
        for (const { owner_id, mn } of owners) {
            const id = crypto.randomUUID();
            anchorOf.set(owner_id, id);
            insert.run({
                id, parent_id: null, owner_id, content: ANCHOR_CONTENT,
                label: null, created_at: mn ?? Date.now(),
            });
            report.anchorsCreated++;
            report.rowsWritten++;
        }
    })();

    // ---- phase 2: top-down expand + dedup ---------------------------------
    const rootsOf = src.prepare('SELECT id, parent_id, owner_id, content, label, created_at FROM messages WHERE owner_id = @o AND parent_id IS NULL ORDER BY created_at ASC, id ASC');
    const childrenOf = src.prepare('SELECT id, parent_id, owner_id, content, label, created_at FROM messages WHERE parent_id = @p ORDER BY created_at ASC, id ASC');

    /** source row id -> the dest row its selected alternative resolved to */
    const resolved = new Map();
    /** identity key -> dest row id */
    const seen = new Map();

    let batch = [];
    const flush = dst.transaction((rows) => { for (const r of rows) insert.run(r); });
    const push = (r) => { batch.push(r); if (batch.length >= 20000) { flush(batch); batch = []; } };

    for (const { owner_id } of owners) {
        const anchorId = anchorOf.get(owner_id);
        /** @type {{ row: object, destParent: string }[]} */
        const queue = rootsOf.all({ o: owner_id }).map(row => ({ row, destParent: anchorId }));

        while (queue.length) {
            const { row, destParent } = queue.shift();

            let msg;
            try {
                msg = JSON.parse(row.content);
            } catch (err) {
                report.errors.push(`unparseable content on ${row.id}: ${err.message}`);
                push({
                    id: row.id, parent_id: destParent, owner_id: row.owner_id,
                    content: row.content, label: row.label, created_at: row.created_at,
                });
                report.rowsWritten++;
                resolved.set(row.id, row.id);
                for (const c of childrenOf.all({ p: row.id })) queue.push({ row: c, destParent: row.id });
                continue;
            }

            if (row.label) report.preexistingBookmarkLabels++;

            const swipes = Array.isArray(msg.swipes) ? msg.swipes : null;
            if (swipes && swipes.length > 0) {
                const raw = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
                const oor = raw < 0 || raw >= swipes.length;
                if (oor) report.swipeIdClamped++;
                if (msg.mes !== swipes[oor ? 0 : raw]) report.mesOverriddenBySwipe++;
            }

            const { contents, selected } = alternativesFromMessage(msg);
            let selectedDest = null;

            for (let k = 0; k < contents.length; k++) {
                const key = nodeIdentityKey(destParent, contents[k]);
                let id = seen.get(key);
                if (id) {
                    report.alternativesMergedByText++;
                } else {
                    // Reuse the source row id for its own selected alternative; that keeps the
                    // overwhelmingly common case identity-stable and cheap.
                    id = (k === selected) ? row.id : crypto.randomUUID();
                    push({
                        id,
                        parent_id: destParent,
                        owner_id: row.owner_id,
                        content: contents[k],
                        label: k === selected ? row.label : null,
                        // Sibling order IS alternative order, and (created_at, id) is the ordering key
                        // everywhere in this schema, so +k keeps the order from collapsing to
                        // random-uuid order. created_at here is bookkeeping; the message time lives in
                        // content.send_date.
                        created_at: row.created_at + k,
                    });
                    report.rowsWritten++;
                    seen.set(key, id);
                }
                if (k === selected) selectedDest = id;
            }

            if (selectedDest !== row.id) report.sourceRowsMergedIntoAnother++;
            resolved.set(row.id, selectedDest);

            for (const c of childrenOf.all({ p: row.id })) queue.push({ row: c, destParent: selectedDest });
        }
    }
    if (batch.length) { flush(batch); batch = []; }

    report.sourceRowsUnreachable = report.sourceMessages - resolved.size;
    if (report.sourceRowsUnreachable > 0) {
        report.errors.push(`${report.sourceRowsUnreachable} source rows were not reachable from any root and were not migrated`);
    }

    dst.exec(INDEXES);

    // ---- phase 3: branches -> labels + metadata ----------------------------
    const branches = src.prepare('SELECT id, owner_id, leaf_id, name, is_group, metadata, created_at FROM branches').all();
    /** dest leaf id -> branch rows landing on it */
    const byLeaf = new Map();
    for (const b of branches) {
        const destLeaf = resolved.get(b.leaf_id);
        if (!destLeaf) {
            report.errors.push(`branch "${b.name}" points at leaf ${b.leaf_id} which did not migrate`);
            continue;
        }
        if (!byLeaf.has(destLeaf)) byLeaf.set(destLeaf, []);
        byLeaf.get(destLeaf).push(b);
    }

    const setLabel = dst.prepare('UPDATE messages SET label = @label, metadata = @metadata WHERE id = @id');
    const getRow = dst.prepare('SELECT id, label FROM messages WHERE id = @id');

    dst.transaction(() => {
        for (const [leafId, rows] of byLeaf) {
            rows.sort((a, b) => (a.created_at - b.created_at) || String(a.id).localeCompare(String(b.id)));
            const winner = rows[0];
            for (const loser of rows.slice(1)) {
                report.droppedChatNames.push({
                    leaf_id: leafId,
                    dropped_name: loser.name,
                    kept_name: winner.name,
                    metadata_differed: loser.metadata !== winner.metadata,
                    same_source_leaf: loser.leaf_id === winner.leaf_id,
                });
            }

            const target = getRow.get({ id: leafId });
            if (!target) {
                report.errors.push(`branch "${winner.name}" resolved to missing dest leaf ${leafId}`);
                continue;
            }
            if (target.label) report.bookmarkLabelsOverwrittenByChatName++;

            let meta = winner.metadata;
            if (winner.is_group) {
                let obj = {};
                try { obj = meta ? JSON.parse(meta) : {}; } catch { obj = {}; }
                obj.__is_group = true;
                meta = JSON.stringify(obj);
            }
            setLabel.run({ id: leafId, label: winner.name, metadata: meta ?? null });
            report.labelsWritten++;
        }
    })();

    // ---- phase 4: default_child_id chains ----------------------------------
    const ordered = [...byLeaf.entries()]
        .map(([leafId, rows]) => ({ leafId, created_at: Math.min(...rows.map(r => r.created_at)) }))
        .sort((a, b) => (a.created_at - b.created_at) || a.leafId.localeCompare(b.leafId));

    const parentOf = dst.prepare('SELECT parent_id FROM messages WHERE id = @id');
    const setDefault = dst.prepare('UPDATE messages SET default_child_id = @child WHERE id = @parent');

    dst.transaction(() => {
        for (const { leafId } of ordered) {
            let child = leafId;
            const seenUp = new Set([child]);
            for (;;) {
                const p = parentOf.get({ id: child })?.parent_id;
                if (!p || seenUp.has(p)) break;
                setDefault.run({ parent: p, child });
                report.defaultChildEdges++;
                seenUp.add(p);
                child = p;
            }
        }
    })();

    // ---- verification ------------------------------------------------------
    const one = (s, p) => dst.prepare(s).get(p ?? {});
    report.verification = {
        messages: one('SELECT count(*) c FROM messages').c,
        anchors: one('SELECT count(*) c FROM messages WHERE parent_id IS NULL').c,
        ownersWithExactlyOneAnchor: one('SELECT count(*) c FROM (SELECT owner_id FROM messages WHERE parent_id IS NULL GROUP BY owner_id HAVING count(*) = 1)').c,
        labeled: one('SELECT count(*) c FROM messages WHERE label IS NOT NULL').c,
        orphanParents: one('SELECT count(*) c FROM messages m WHERE m.parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.id = m.parent_id)').c,
        danglingDefaultChild: one('SELECT count(*) c FROM messages m WHERE m.default_child_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM messages k WHERE k.id = m.default_child_id AND k.parent_id = m.id)').c,
        residualSwipeFields: one("SELECT count(*) c FROM messages WHERE json_extract(content,'$.swipes') IS NOT NULL OR json_extract(content,'$.swipe_info') IS NOT NULL OR json_extract(content,'$.swipe_id') IS NOT NULL").c,
        duplicateSiblingTexts: one("SELECT count(*) c FROM (SELECT parent_id FROM messages WHERE parent_id IS NOT NULL GROUP BY parent_id, coalesce(json_extract(content,'$.is_user'),0), json_extract(content,'$.name'), json_extract(content,'$.mes') HAVING count(*) > 1)").c,
        worstFanOut: one('SELECT coalesce(max(c),0) c FROM (SELECT count(*) c FROM messages WHERE parent_id IS NOT NULL GROUP BY parent_id)').c,
        worstAnchorFanOut: one('SELECT coalesce(max(c),0) c FROM (SELECT count(*) c FROM messages m JOIN messages p ON p.id = m.parent_id WHERE p.parent_id IS NULL GROUP BY m.parent_id)').c,
        branchesTableExists: !!one("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='branches'"),
    };
    report.elapsedMs = Date.now() - t0;

    dst.exec('VACUUM');
    dst.close();
    src.close();
    report.destBytes = fs.statSync(dstPath).size;

    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    const { droppedChatNames, errors, ...summary } = report;
    console.log(JSON.stringify(summary, null, 2));
    console.log(`dropped chat names: ${droppedChatNames.length}`);
    for (const d of droppedChatNames) {
        console.log(`  DROP "${d.dropped_name}"  (kept "${d.kept_name}", metadata differed: ${d.metadata_differed}, same source leaf: ${d.same_source_leaf})`);
    }
    console.log(`errors: ${errors.length}`);
    for (const e of errors.slice(0, 20)) console.log('  ' + e);
}

main();
