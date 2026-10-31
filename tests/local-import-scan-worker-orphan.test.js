import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('png-chunk-text')} */
let PNGtext;
/** @type {typeof import('../src/png/encode.js').default} */
let pngEncode;

const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    fixture = await import('./converted-user.fixture.js');
    ({ default: extract } = await import('png-chunks-extract'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
    ({ default: pngEncode } = await import('../src/png/encode.js'));
});

/**
 * @param {string} dir
 * @param {string} filename
 */
function writeMalformedPngCharacterFile(dir, filename) {
    const notJsonBase64 = Buffer.from('this is not valid JSON {{{', 'utf8').toString('base64');
    const chunks = extract(new Uint8Array(BLANK_PNG));
    chunks.splice(-1, 0, PNGtext.encode('chara', notJsonBase64));
    fs.writeFileSync(path.join(dir, filename), Buffer.from(pngEncode(chunks)));
}

async function characterCount() {
    return (await user.store.lib.query({ wantRows: false, wantTotal: true, includeGroups: false })).total;
}

describe('local-import-scan: a build-time throw does not permanently orphan a worker pool slot', () => {
    let tempDir;
    let sourceDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(async () => {
        user = await fixture.emptyUser('st-local-import-scan-worker-orphan-');
        tempDir = user.dataRoot;
        directories = user.directories;
        sourceDir = path.join(tempDir, 'watched');
        fs.mkdirSync(sourceDir, { recursive: true });
        globalThis.DATA_ROOT = tempDir;

        process.env.SILLYTAVERN_PERFORMANCE_LOCALIMPORTWORKERPOOLSIZE = '1';
        process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'false';
    });

    afterEach(async () => {
        localImportScan.disposeLocalImportScan();
        await user.close();
        delete process.env.SILLYTAVERN_PERFORMANCE_LOCALIMPORTWORKERPOOLSIZE;
        delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
    });

    test('a well-formed file scanned in a LATER pass still gets imported, not left hanging forever', async () => {
        writeMalformedPngCharacterFile(sourceDir, 'malformed.png');
        const state = { sourceDir, lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
        await localImportScan.scanDirectory(state, directories);
        expect(await characterCount()).toBe(0);

        fs.writeFileSync(path.join(sourceDir, 'ghost.json'), JSON.stringify({ name: 'Ghost', description: 'ok' }));
        await localImportScan.scanDirectory(state, directories);

        expect(await characterCount()).toBe(1);
        const page = await user.store.lib.query({ wantRows: true, includeGroups: false, limit: 5 });
        expect(/** @type {any} */ (page.rows)[0].item.name).toBe('Ghost');
    });
});
