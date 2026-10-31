import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

let findCharacterIdByContentHashCallCount = 0;
/** @type {number} */
let findCharacterIdByContentHashStallMs = 0;

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    fixture = await import('./converted-user.fixture.js');
    localImportScan = await import('../src/local-import-scan.js');
    cardParser = await import('../src/character-card-parser.js');
});

describe('local-import-scan: concurrent processFile() calls for the SAME filename (watcher/periodic-scan overlap)', () => {
    let tempDir;
    let sourceDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(async () => {
        user = await fixture.emptyUser('st-local-import-scan-inflight-test-');
        tempDir = user.dataRoot;
        directories = user.directories;
        sourceDir = path.join(tempDir, 'watched');
        fs.mkdirSync(sourceDir, { recursive: true });
        globalThis.DATA_ROOT = tempDir;
        const findByHash = user.store.lib.findByHash.bind(user.store.lib);
        user.store.lib.findByHash = async (...args) => {
            findCharacterIdByContentHashCallCount++;
            if (findCharacterIdByContentHashStallMs > 0) {
                await new Promise(resolve => setTimeout(resolve, findCharacterIdByContentHashStallMs));
            }
            return findByHash(...args);
        };

        findCharacterIdByContentHashCallCount = 0;
        findCharacterIdByContentHashStallMs = 0;
    });

    afterEach(() => user.close());

    async function characterCount() {
        return (await user.store.lib.query({ wantRows: false, wantTotal: true, includeGroups: false })).total;
    }

    afterAll(() => {
        localImportScan.disposeLocalImportScan();
    });

    /** @returns {{ sourceDir: string, lastSeenMtimeMs: Map<string, number>, watcher: null, watchTimers: Map<string, NodeJS.Timeout> }} */
    function buildState() {
        return { sourceDir, lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
    }

    test('two concurrent scanDirectory() passes over a file that is ALREADY a duplicate only process it once, not once per pass', async () => {
        const cardBuffer = cardParser.write(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ghost' } }));
        fs.writeFileSync(path.join(sourceDir, 'ghost.png'), cardBuffer);
        const state = buildState();
        await localImportScan.scanDirectory(state, directories);
        expect(await characterCount()).toBe(1);
        findCharacterIdByContentHashCallCount = 0;

        fs.writeFileSync(path.join(sourceDir, 'ghost-copy.png'), cardBuffer);
        findCharacterIdByContentHashStallMs = 50;

        await Promise.all([
            localImportScan.scanDirectory(state, directories),
            localImportScan.scanDirectory(state, directories),
        ]);

        expect(await characterCount()).toBe(1);

        expect(findCharacterIdByContentHashCallCount).toBe(1);
    });
});
