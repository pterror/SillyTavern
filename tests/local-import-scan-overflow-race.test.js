import { describe, test, expect, jest, beforeAll, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

// Regression coverage for a real bug: triggerImmediateRescan() (local-import-scan.js) used to gate on
// `scanTimeout` being non-null as its own "nothing is running, safe to trigger now" check. That's wrong -
// scheduleNext()'s setTimeout callback never nulls `scanTimeout` when it actually fires, only
// triggerImmediateRescan() itself (and disposeLocalImportScan()) ever did. So for the entire duration of a
// NORMALLY-scheduled pass, `scanTimeout` still held the old, already-fired Timeout object - truthy,
// indistinguishable from "still waiting". A watcher-overflow signal (watch-overflow.js) landing during that
// window - exactly what a sustained burst of writes into a watched directory produces - would pass that stale
// check and launch a SECOND, fully concurrent pass on top of the one already running. This test simulates that
// exact signal arriving mid-pass and asserts no second pass gets started.
//
// The overflow-watch native binding is mocked at the module boundary (rather than relying on the real Linux
// inotify addon) so this test can trigger the signal deterministically instead of needing a real queue overflow.
/** @type {(() => void) | null} */
let capturedOnOverflow = null;
jest.unstable_mockModule('../src/watch-overflow.js', () => ({
    attachLinuxDirectoryWatch: jest.fn((_dir, { onOverflow }) => {
        capturedOnOverflow = onOverflow;
        // Resolve null (as if the native watch never confirmed attached) so allOverflowConfirmed() stays
        // false and local-import-scan.js keeps scheduling ordinary periodic passes (scanIntervalMs) instead of
        // switching into heartbeat mode - this test is specifically about the periodic-pass reentrancy guard.
        // startWatcherFor() falls back to plain fs.watch() for event delivery when this resolves null, same as
        // it always has for a failed/unavailable native attach.
        return Promise.resolve(null);
    }),
    isWindowsOverflowSignal: () => false,
}));

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {typeof import('../src/local-import-scan.js')} */
let localImportScan;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/users.js')} */
let users;
/** @type {typeof import('../src/constants.js')} */
let constants;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));
    process.chdir(path.resolve(originalCwd, '..'));

    localImportScan = await import('../src/local-import-scan.js');
    metadataDb = await import('../src/character-metadata-db.js');
    users = await import('../src/users.js');
    constants = await import('../src/constants.js');
});

describe('local-import-scan: watcher-overflow signal during an in-flight periodic pass', () => {
    let dataRoot;
    let userCharactersDir;
    let sourceDir;

    beforeAll(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-local-import-scan-overflow-test-'));
        globalThis.DATA_ROOT = dataRoot;
        const userDirectories = users.getUserDirectories(constants.DEFAULT_USER.handle);
        userCharactersDir = userDirectories.characters;
        fs.mkdirSync(userCharactersDir, { recursive: true });
        fs.mkdirSync(userDirectories.chats, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(dataRoot, { recursive: true, force: true });
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
        metadataDb.disposeMetadataStores();
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
        jest.useFakeTimers();
        const realReaddir = fs.promises.readdir.bind(fs.promises);
        let readdirCallCount = 0;
        /** @type {() => void} */
        let releaseSecondCall = () => {};
        const readdirSpy = jest.spyOn(fs.promises, 'readdir').mockImplementation(async (...args) => {
            readdirCallCount++;
            if (readdirCallCount === 2) {
                // Stall the SECOND pass - the one started by a real, already-fired scheduled timer, i.e. exactly
                // the condition under which `scanTimeout` used to still look truthy despite this pass being
                // genuinely in flight - until this test explicitly releases it below.
                await new Promise(resolve => { releaseSecondCall = resolve; });
            }
            return realReaddir(...args);
        });

        try {
            await localImportScan.initializeLocalImportScan();
            await localImportScan.waitForCurrentScanPass(); // first pass (readdir call #1) - fast, empty dir
            expect(typeof capturedOnOverflow).toBe('function');

            // Fire the real scheduled timer for the SECOND pass (readdir call #2, stalled by the mock above).
            await jest.advanceTimersByTimeAsync(1000);
            await Promise.resolve();
            await Promise.resolve();
            expect(readdirCallCount).toBe(2);

            // Simulate a watcher-overflow signal arriving WHILE that second pass is still stalled inside its own
            // readdir() call - the exact window the historical bug launched an overlapping third pass in.
            capturedOnOverflow();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            // Fixed behavior: passInFlight blocks the overflow-triggered rescan outright - no third readdir call.
            expect(readdirCallCount).toBe(2);
        } finally {
            releaseSecondCall();
            readdirSpy.mockRestore();
            jest.useRealTimers();
        }

        // Let the now-released second pass actually finish before teardown.
        await localImportScan.waitForCurrentScanPass();
    });
});
