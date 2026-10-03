import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { main } from '../src/migrations/convert-world-info-to-sidecar.js';

/** @type {typeof import('../src/endpoints/worldinfo.js')} */
let worldinfo;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    worldinfo = await import('../src/endpoints/worldinfo.js');
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const notRunning = async () => ({ running: false, lines: [] });
const NOW = new Date('2026-10-03T12:00:00.000Z');
const STAMP = '2026-10-03T12-00-00-000Z';

function makeEntry(uid, content) {
    return { uid, key: [`key${uid}`], content };
}

/** A data root with one user, `u`, and an empty worlds directory. */
function dataRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-world-info-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, 'u', 'worlds'), { recursive: true });
    return root;
}

function worldsDir(root) {
    return path.join(root, 'u', 'worlds');
}

function directories(root) {
    return /** @type {any} */ ({ worlds: worldsDir(root), root: path.join(root, 'u') });
}

function backupDir(root) {
    return path.join(root, 'u', 'backups', '_convert-world-info', STAMP);
}

/** Writes a book in upstream's format: entries inline. */
function writeUpstream(root, name, book) {
    fs.writeFileSync(path.join(worldsDir(root), `${name}.json`), JSON.stringify(book));
}

/** Writes a book in the earlier stored format: the manifest lists entry uids, each entry in `<uid>.json`. */
function writeV1(root, name, book) {
    const { entries, ...rest } = book;
    const entriesDir = path.join(worldsDir(root), `${name}.entries`);
    fs.mkdirSync(entriesDir);
    for (const [uid, entry] of Object.entries(entries)) {
        fs.writeFileSync(path.join(entriesDir, `${uid}.json`), JSON.stringify(entry, null, 4));
    }
    fs.writeFileSync(path.join(worldsDir(root), `${name}.json`), JSON.stringify({ ...rest, format: 'sidecar-v1', entries: Object.keys(entries) }, null, 4));
}

/**
 * Every file under `dir`, with its contents.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function snapshot(dir) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        const full = path.join(entry.parentPath, entry.name);
        out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
    return out;
}

/**
 * @param {string} root
 * @param {string[]} args
 * @param {object} [more]
 */
async function run(root, args, more = {}) {
    /** @type {string[]} */
    const lines = [];
    const code = await main([...args, '--data-root', root, '--handle', 'u'], {
        probeServer: notRunning, log: l => lines.push(l), warn: l => lines.push(l), now: NOW, ...more,
    });
    return { code, lines };
}

const UPSTREAM_BOOK = { entries: { 0: makeEntry(0, 'Inline zero'), 3: makeEntry(3, 'Inline three') }, name: 'Upstream', extensions: { a: 1 } };
const V1_BOOK = { entries: { 1: makeEntry(1, 'Sidecar one'), 2: makeEntry(2, 'Sidecar two') }, name: 'Older', extensions: { b: 2 } };

describe('convert-world-info-to-sidecar', () => {
    test('without exactly one of --dry-run / --apply, or with an unknown argument, prints usage and exits 2', async () => {
        const root = dataRoot();
        expect((await run(root, [])).code).toBe(2);
        expect((await run(root, ['--dry-run', '--apply'])).code).toBe(2);
        expect((await run(root, ['--dry-run', '--bogus'])).code).toBe(2);
    });

    test('the real run is refused without --server-stopped, and writes nothing', async () => {
        const root = dataRoot();
        writeUpstream(root, 'Upstream', UPSTREAM_BOOK);
        const before = snapshot(root);

        const { code, lines } = await run(root, ['--apply']);

        expect(code).toBe(1);
        expect(lines.join('\n')).toContain('REFUSED');
        expect(snapshot(root)).toEqual(before);
    });

    test('the real run is refused when the probe says the server is running, and writes nothing', async () => {
        const root = dataRoot();
        writeUpstream(root, 'Upstream', UPSTREAM_BOOK);
        const before = snapshot(root);

        const { code, lines } = await run(root, ['--apply', '--server-stopped'], { probeServer: async () => ({ running: true, lines: [] }) });

        expect(code).toBe(1);
        expect(lines.join('\n')).toContain('REFUSED');
        expect(snapshot(root)).toEqual(before);
    });

    test('the dry run lists what it would convert and writes nothing', async () => {
        const root = dataRoot();
        writeUpstream(root, 'Upstream', UPSTREAM_BOOK);
        writeV1(root, 'Older', V1_BOOK);
        const before = snapshot(root);

        const { code, lines } = await run(root, ['--dry-run']);

        expect(code).toBe(0);
        expect(lines.some(l => l.includes('WOULD CONVERT Upstream.json'))).toBe(true);
        expect(lines.some(l => l.includes('WOULD CONVERT Older.json'))).toBe(true);
        expect(snapshot(root)).toEqual(before);
    });

    test('the real run converts a book in upstream\'s format; it reads back the same, and the original is in the backup', async () => {
        const root = dataRoot();
        writeUpstream(root, 'Upstream', UPSTREAM_BOOK);
        const original = fs.readFileSync(path.join(worldsDir(root), 'Upstream.json'), 'utf8');

        const { code } = await run(root, ['--apply', '--server-stopped']);

        expect(code).toBe(0);
        expect(worldinfo.readWorldInfoFile(directories(root), 'Upstream', false)).toEqual(UPSTREAM_BOOK);
        expect(fs.readFileSync(path.join(backupDir(root), 'Upstream.json'), 'utf8')).toBe(original);
    });

    test('the real run converts a book in the earlier stored format; it reads back the same, its old entry files are gone, and both are in the backup', async () => {
        const root = dataRoot();
        writeV1(root, 'Older', V1_BOOK);
        const before = snapshot(worldsDir(root));

        const { code } = await run(root, ['--apply', '--server-stopped']);

        expect(code).toBe(0);
        expect(worldinfo.readWorldInfoFile(directories(root), 'Older', false)).toEqual(V1_BOOK);
        const entryFiles = fs.readdirSync(path.join(worldsDir(root), 'Older.entries'));
        expect(entryFiles).not.toContain('1.json');
        expect(entryFiles).not.toContain('2.json');
        expect(snapshot(backupDir(root))).toEqual(before);
    });

    test('a book already in the stored format is left alone', async () => {
        const root = dataRoot();
        worldinfo.importWorldInfoFromRaw(directories(root), 'Current.json', JSON.stringify(UPSTREAM_BOOK));
        const before = snapshot(root);

        const { code, lines } = await run(root, ['--apply', '--server-stopped']);

        expect(code).toBe(0);
        expect(lines.some(l => l.includes('Current.json'))).toBe(false);
        expect(snapshot(root)).toEqual(before);
    });

    test('a file that can\'t be parsed is listed and left as it is; the run exits 1', async () => {
        const root = dataRoot();
        fs.writeFileSync(path.join(worldsDir(root), 'Broken.json'), '{ not json');
        writeUpstream(root, 'Upstream', UPSTREAM_BOOK);

        const { code, lines } = await run(root, ['--apply', '--server-stopped']);

        expect(code).toBe(1);
        expect(lines.some(l => l.includes('LEFT AS IT IS Broken.json'))).toBe(true);
        expect(fs.readFileSync(path.join(worldsDir(root), 'Broken.json'), 'utf8')).toBe('{ not json');
        expect(fs.existsSync(path.join(backupDir(root), 'Broken.json'))).toBe(false);
        expect(worldinfo.readWorldInfoFile(directories(root), 'Upstream', false)).toEqual(UPSTREAM_BOOK);
    });
});
