import { test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/migrations/migration-notices.js')} */
let notices;

let tempDir;
let charactersDir;
let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    notices = await import('../src/migrations/migration-notices.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-unimport-embedded-lore-test-'));
    charactersDir = path.join(tempDir, 'characters');
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, worlds: worldsDir, chats: path.join(tempDir, 'chats'), groups: path.join(tempDir, 'groups') };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

function makeCard(avatar, overrides = {}) {
    const name = avatar.replace(/\.png$/, '');
    return {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
}

const NOTICE_ID = 'unimport-embedded-lore';

/** Every pending row of `migration`, gathered - only ever a test's handful. */
async function pendingRows(migration) {
    const rows = [];
    for await (const page of await metadataDb.streamMigrationPending(directories, migration)) {
        rows.push(...page);
    }
    return rows;
}

test('NoticeCollector counts every entry and keeps the first 20', () => {
    const skipped = Array.from({ length: 25 }, (_, i) => ({ avatar: `s${i}.png`, world: `S${i}`, reason: 'world-unreadable' }));
    const failing = Array.from({ length: 3 }, (_, i) => ({ avatar: `f${i}.png`, world: `F${i}` }));
    const collector = new notices.NoticeCollector();
    for (const entry of skipped) collector.addSkipped(entry);
    for (const entry of failing) collector.addFailing(entry);

    expect(collector.skipped.total).toBe(25);
    expect(collector.failing.total).toBe(3);
    expect(collector.skipped.entries).toEqual(skipped.slice(0, 20));
    expect(collector.failing.entries).toEqual(failing);
    expect(collector.isEmpty()).toBe(false);
    expect(new notices.NoticeCollector().isEmpty()).toBe(true);
});

test('replaceNotice stores a notice, a later one gets a higher version, and an empty collector deletes it', async () => {
    const first = new notices.NoticeCollector();
    first.addSkipped({ avatar: 'a.png', world: 'A', reason: 'world-unreadable' });
    await notices.replaceNotice(directories, NOTICE_ID, first);
    const stored = await notices.readNotice(directories, NOTICE_ID);
    expect(stored).toMatchObject({
        skipped: { total: 1, entries: [{ avatar: 'a.png', world: 'A', reason: 'world-unreadable' }] },
        failing: { total: 0, entries: [] },
    });

    const second = new notices.NoticeCollector();
    second.addFailing({ avatar: 'b.png', world: 'B' });
    await notices.replaceNotice(directories, NOTICE_ID, second);
    const replaced = await notices.readNotice(directories, NOTICE_ID);
    expect(replaced).toMatchObject({
        skipped: { total: 0, entries: [] },
        failing: { total: 1, entries: [{ avatar: 'b.png', world: 'B' }] },
    });
    expect(replaced.version).toBeGreaterThan(stored.version);

    await notices.replaceNotice(directories, NOTICE_ID, new notices.NoticeCollector());
    expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();
    expect(await notices.readNoticeRaw(directories, NOTICE_ID)).toBeNull();
});

test('markNoticeSeen clears the notice only for its current version', async () => {
    const collector = new notices.NoticeCollector();
    collector.addSkipped({ avatar: 'a.png', world: 'A', reason: 'world-unreadable' });
    await notices.replaceNotice(directories, NOTICE_ID, collector);
    const { version } = await notices.readNotice(directories, NOTICE_ID);

    expect(await notices.markNoticeSeen(directories, NOTICE_ID, version - 1)).toBe(false);
    expect(await notices.readNotice(directories, NOTICE_ID)).not.toBeNull();
    expect(await notices.markNoticeSeen(directories, NOTICE_ID, version)).toBe(true);
    expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();
    expect(await notices.markNoticeSeen(directories, NOTICE_ID, version)).toBe(false);
});

test('mergeRetryNotice adds the skipped lists and replaces the failing list', () => {
    expect(notices.mergeRetryNotice(null, new notices.NoticeCollector())).toBeNull();

    const x = { avatar: 'x.png', world: 'X' };
    const y = { avatar: 'y.png', world: 'Y', reason: 'world-unreadable' };
    const previousSkipped = Array.from({ length: 20 }, (_, i) => ({ avatar: `p${i}.png`, world: `P${i}`, reason: 'world-unreadable' }));
    const previous = { version: 1, skipped: { total: 21, entries: previousSkipped }, failing: { total: 1, entries: [x] } };
    const collector = new notices.NoticeCollector();
    collector.addSkipped(y);
    expect(notices.mergeRetryNotice(previous, collector)).toEqual({
        skipped: { total: 22, entries: previousSkipped },
        failing: { total: 0, entries: [] },
        undone: { total: 0, entries: [] },
    });

    const emptyPrevious = { version: 1, skipped: { total: 0, entries: [] }, failing: { total: 1, entries: [x] } };
    expect(notices.mergeRetryNotice(emptyPrevious, new notices.NoticeCollector())).toBeNull();
});

test('getNoticesForClient names each listed character from the index, or null when it has no row', async () => {
    const card = makeCard('Named.png', { name: 'Named Person', data: { ...makeCard('Named.png').data, name: 'Named Person' } });
    await metadataDb.upsertCharacterFromWrite(directories, 'Named.png', JSON.stringify(card), null, null);
    const collector = new notices.NoticeCollector();
    collector.addSkipped({ avatar: 'Named.png', world: 'Lost', reason: 'world-unreadable' });
    collector.addFailing({ avatar: 'Gone.png', world: 'W' });
    await notices.replaceNotice(directories, NOTICE_ID, collector);
    const { version } = await notices.readNotice(directories, NOTICE_ID);

    expect(await notices.getNoticesForClient(directories)).toEqual([{
        id: 'unimport-embedded-lore',
        version,
        skipped: { total: 1, entries: [{ avatar: 'Named.png', world: 'Lost', reason: 'world-unreadable', name: 'Named Person' }] },
        failing: { total: 1, entries: [{ avatar: 'Gone.png', world: 'W', name: null }] },
        undone: { total: 0, entries: [] },
        hasReport: false,
    }]);
});

test('a card whose lorebook file is missing is nothing to tell: it is not collected, and alone it stores no notice', async () => {
    const collector = new notices.NoticeCollector();
    collector.addSkipped({ avatar: 'a.png', world: 'Gone', reason: 'world-missing' });
    expect(collector.isEmpty()).toBe(true);
    await notices.replaceNotice(directories, NOTICE_ID, collector);
    expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();

    collector.addSkipped({ avatar: 'b.png', world: 'Bad', reason: 'world-unreadable' });
    expect(collector.skipped).toEqual({ total: 1, entries: [{ avatar: 'b.png', world: 'Bad', reason: 'world-unreadable' }] });
});

test('undone cards are collected, stored and add up across retries', async () => {
    const collector = new notices.NoticeCollector();
    collector.addUndone({ avatar: 'a.png', world: 'A' });
    await notices.replaceNotice(directories, NOTICE_ID, collector);
    const stored = await notices.readNotice(directories, NOTICE_ID);
    expect(stored.undone).toEqual({ total: 1, entries: [{ avatar: 'a.png', world: 'A' }] });

    const more = new notices.NoticeCollector();
    more.addUndone({ avatar: 'b.png', world: 'B' });
    expect(notices.mergeRetryNotice(stored, more).undone.total).toBe(2);
});

test('a notice an earlier version stored with only cards linking a missing lorebook is not shown', async () => {
    await metadataDb.setMetaValue(directories, notices.noticeKey(NOTICE_ID), JSON.stringify({
        version: 5,
        skipped: { total: 0, entries: [] },
        failing: { total: 0, entries: [] },
        noWorld: { total: 2538, entries: [{ avatar: 'n.png', world: 'Nowhere', reason: 'world-missing' }] },
    }));
    expect(await notices.getNoticesForClient(directories)).toEqual([]);
});

test('migration_pending: add, settle, stream in id order, and commit deletes settled rows with the notice in one call', async () => {
    await metadataDb.addMigrationPending(directories, 'm', 'b');
    await metadataDb.addMigrationPending(directories, 'm', 'a');
    await metadataDb.addMigrationPending(directories, 'm', 'c');
    await metadataDb.setMigrationPendingSettled(directories, 'm', 'b', true);
    expect(await pendingRows('m')).toEqual([{ id: 'a', settled: 0 }, { id: 'b', settled: 1 }, { id: 'c', settled: 0 }]);

    await metadataDb.commitMigrationSettled(directories, 'm', 'k', 'v');
    expect(await pendingRows('m')).toEqual([{ id: 'a', settled: 0 }, { id: 'c', settled: 0 }]);
    expect(await metadataDb.getMetaValue(directories, 'k')).toBe('v');

    await metadataDb.commitMigrationSettled(directories, 'm', 'k', null);
    expect(await metadataDb.getMetaValue(directories, 'k')).toBeNull();

    await metadataDb.setMetaValue(directories, 'k', 'w');
    await metadataDb.commitMigrationSettled(directories, 'm', 'k', undefined);
    expect(await metadataDb.getMetaValue(directories, 'k')).toBe('w');

    expect(await metadataDb.hasMigrationPending(directories, 'm')).toBe(true);
    await metadataDb.addMigrationPending(directories, 'm', 'a');
    expect((await pendingRows('m')).filter(row => row.id === 'a')).toEqual([{ id: 'a', settled: 0 }]);
    await metadataDb.clearMigrationPending(directories, 'm');
    expect(await metadataDb.hasMigrationPending(directories, 'm')).toBe(false);
});

test('deleteMetaValueIfEquals deletes only when the value matches', async () => {
    await metadataDb.setMetaValue(directories, 'k', 'v');
    expect(await metadataDb.deleteMetaValueIfEquals(directories, 'k', 'other')).toBe(false);
    expect(await metadataDb.getMetaValue(directories, 'k')).toBe('v');
    expect(await metadataDb.deleteMetaValueIfEquals(directories, 'k', 'v')).toBe(true);
    expect(await metadataDb.getMetaValue(directories, 'k')).toBeNull();
    expect(await metadataDb.deleteMetaValueIfEquals(directories, 'k', 'v')).toBe(false);
});
