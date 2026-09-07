import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

// Regression coverage for a real bug: buildPngImportData()/buildJsonImportData() (characters.js) can throw on
// malformed/unexpected input (JSON.parse, sanitize(), etc.) - a real risk on a scraped corpus, not hypothetical.
// PNG candidates have no pre-classification guard the way .json ones do (classifyJsonCandidate() only runs for
// format === 'json' - see local-import-worker.js), so a PNG with an unparseable embedded 'chara' chunk reaches
// buildPngImportData()'s unguarded JSON.parse() directly. Before the fix, that throw propagated straight out of
// processFile()'s per-hash-locked section without ever calling pipelineResult.finish() - permanently orphaning
// that worker's held source buffer/chunk list AND leaving its pool slot stuck "busy" forever (see
// local-import-worker-pool.js's runPipeline() doc comment). With the pool forced to size 1 below, that means
// every file dispatched after the malformed one just hangs forever waiting for a worker that never frees up -
// this test proves a well-formed file queued right after a malformed one still gets processed instead of the
// whole scan pass silently hanging.
const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('png-chunks-extract').default} */
let extract;
/** @type {typeof import('png-chunk-text')} */
let PNGtext;
/** @type {typeof import('../src/png/encode.js').default} */
let pngEncode;

// A minimal valid 1x1 transparent PNG - same fixture other local-import-scan tests use.
const BLANK_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    metadataDb = await import('../src/character-metadata-db.js');
    ({ default: extract } = await import('png-chunks-extract'));
    PNGtext = (await import('png-chunk-text')).default ?? await import('png-chunk-text');
    ({ default: pngEncode } = await import('../src/png/encode.js'));
});

/**
 * Writes a PNG whose 'chara' tEXt chunk decodes to bytes that are NOT valid JSON - reaches
 * buildPngImportData()'s unguarded `JSON.parse(rawText)` and throws, since PNG candidates have no
 * classifyJsonCandidate()-style pre-check the way .json ones do.
 * @param {string} dir
 * @param {string} filename
 */
function writeMalformedPngCharacterFile(dir, filename) {
    const notJsonBase64 = Buffer.from('this is not valid JSON {{{', 'utf8').toString('base64');
    const chunks = extract(new Uint8Array(BLANK_PNG));
    chunks.splice(-1, 0, PNGtext.encode('chara', notJsonBase64));
    fs.writeFileSync(path.join(dir, filename), Buffer.from(pngEncode(chunks)));
}

describe('local-import-scan: a build-time throw does not permanently orphan a worker pool slot', () => {
    let tempDir;
    let sourceDir;
    let charactersDir;
    /** @type {import('../src/users.js').UserDirectoryList} */
    let directories;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-worker-orphan-'));
        sourceDir = path.join(tempDir, 'watched');
        charactersDir = path.join(tempDir, 'characters');
        const chatsDir = path.join(tempDir, 'chats');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.mkdirSync(charactersDir, { recursive: true });
        fs.mkdirSync(chatsDir, { recursive: true });
        directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
        globalThis.DATA_ROOT = tempDir;

        // Forces a fresh, size-1 worker pool on this test's first scanDirectory() call - with only one worker,
        // a malformed file's leaked "stuck busy" slot means literally everything dispatched after it can never
        // run, making the orphan bug directly observable via "does the next file still get imported".
        process.env.SILLYTAVERN_PERFORMANCE_LOCALIMPORTWORKERPOOLSIZE = '1';
        // Off so the worker's OWN identity-hash computation never touches JSON.parse on this malformed rawText -
        // that path already fails safely (a single-phase 'done' with no pending buffer left behind). The bug
        // this test targets only exists on the MAIN thread's buildPngImportData() call, reached once the
        // worker's 'parsed' phase succeeds - so identity-hash computation must succeed too, not fail first for
        // an unrelated reason.
        process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK = 'false';
    });

    afterEach(() => {
        localImportScan.disposeLocalImportScan();
        metadataDb.disposeMetadataStores();
        fs.rmSync(tempDir, { recursive: true, force: true });
        delete process.env.SILLYTAVERN_PERFORMANCE_LOCALIMPORTWORKERPOOLSIZE;
        delete process.env.SILLYTAVERN_PERFORMANCE_ALLOWEXPENSIVEDUPLICATEFALLBACK;
    });

    test('a well-formed file scanned in a LATER pass still gets imported, not left hanging forever', async () => {
        // Two separate passes, not two files in one pass - readdir() order within a single pass isn't
        // guaranteed, so dispatching both at once would make this test's outcome depend on which one happens
        // to be processed first. Running the malformed file through its own pass first guarantees the pool's
        // sole worker is already in whatever state the bug leaves it in (stuck "busy", pre-fix) BEFORE the
        // well-formed file is ever dispatched to it in the second pass.
        writeMalformedPngCharacterFile(sourceDir, 'malformed.png');
        const state = { sourceDir, lastSeenMtimeMs: new Map(), watcher: null, watchTimers: new Map() };
        await localImportScan.scanDirectory(state, directories);
        expect(fs.readdirSync(charactersDir).length).toBe(0);

        fs.writeFileSync(path.join(sourceDir, 'ghost.json'), JSON.stringify({ name: 'Ghost', description: 'ok' }));
        await localImportScan.scanDirectory(state, directories);

        const files = fs.readdirSync(charactersDir);
        expect(files.length).toBe(1);
        const row = await metadataDb.getCharacterMetadataRow(directories, files[0]);
        expect(row.name).toBe('Ghost');
    });
});
