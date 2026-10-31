import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

/** @type {(() => void) | null} */
let capturedOnOverflow = null;
jest.unstable_mockModule('../src/watch-overflow.js', () => ({
    attachLinuxDirectoryWatch: jest.fn((_dir, { onOverflow }) => {
        capturedOnOverflow = onOverflow;
        return Promise.resolve(null);
    }),
    isWindowsOverflowSignal: () => false,
}));

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/users.js')} */
let users;
/** @type {typeof import('../src/constants.js')} */
let constants;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    fixture = await import('./converted-user.fixture.js');
    users = await import('../src/users.js');
    constants = await import('../src/constants.js');
});

describe('local-import-scan: watcher-overflow signal during an in-flight periodic pass', () => {
    let dataRoot;
    let userCharactersDir;
    let sourceDir;

    /** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
    let user;

    beforeAll(async () => {
        user = await fixture.emptyUser('st-local-import-scan-overflow-test-');
        dataRoot = user.dataRoot;
        globalThis.DATA_ROOT = dataRoot;
        const userDirectories = users.getUserDirectories(constants.DEFAULT_USER.handle);
        userCharactersDir = userDirectories.characters;
        fs.mkdirSync(userCharactersDir, { recursive: true });
        fs.mkdirSync(userDirectories.chats, { recursive: true });
    });

    afterAll(async () => {
        await user.close();
    });

    beforeEach(() => {
        sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-overflow-watched-'));
        capturedOnOverflow = null;
        delete process.env.SILLYTAVERN_LOCALIMPORT_ENABLED;
        delete process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES;
        delete process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS;
        delete process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED;
        process.env.SILLYTAVERN_LOCALIMPORT_ENABLED = 'true';
        process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES = JSON.stringify([sourceDir]);
        process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS = '1000';
        process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED = 'true';
    });

    afterEach(() => {
        localImportScan.disposeLocalImportScan();
        fs.rmSync(sourceDir, { recursive: true, force: true });
        for (const file of fs.readdirSync(userCharactersDir)) {
            fs.rmSync(path.join(userCharactersDir, file), { force: true });
        }
        delete process.env.SILLYTAVERN_LOCALIMPORT_ENABLED;
        delete process.env.SILLYTAVERN_LOCALIMPORT_DIRECTORIES;
        delete process.env.SILLYTAVERN_LOCALIMPORT_SCANINTERVALMS;
        delete process.env.SILLYTAVERN_LOCALIMPORT_WATCHENABLED;
    });

    test('an overflow signal arriving while a normally-scheduled pass is still running does not start a second, overlapping pass', async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        const settle = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
        const realOpendir = fs.promises.opendir.bind(fs.promises);
        let opendirCallCount = 0;
        /** @type {() => void} */
        let releaseSecondCall = () => {};
        const opendirSpy = jest.spyOn(fs.promises, 'opendir').mockImplementation(async (...args) => {
            opendirCallCount++;
            if (opendirCallCount === 2) {
                await new Promise(resolve => { releaseSecondCall = resolve; });
            }
            return realOpendir(...args);
        });

        try {
            await localImportScan.initializeLocalImportScan();
            await localImportScan.waitForCurrentScanPass();
            expect(typeof capturedOnOverflow).toBe('function');

            await jest.advanceTimersByTimeAsync(1000);
            await settle();
            expect(opendirCallCount).toBe(2);

            capturedOnOverflow();
            await settle();

            expect(opendirCallCount).toBe(2);
        } finally {
            releaseSecondCall();
            opendirSpy.mockRestore();
            jest.useRealTimers();
        }

        await localImportScan.waitForCurrentScanPass();
    });
});
