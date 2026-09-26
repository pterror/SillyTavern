import { describe, test, expect, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const handle = 'backup-test-user';
let backupsDir;
/** @type {typeof import('../src/endpoints/settings.js').isDuplicateBackup} */
let isDuplicateBackup;

beforeAll(async () => {
    globalThis.DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-backup-latest-test-'));
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const { getUserDirectories } = await import('../src/users.js');
    backupsDir = getUserDirectories(handle).backups;
    fs.mkdirSync(backupsDir, { recursive: true });
    ({ isDuplicateBackup } = await import('../src/endpoints/settings.js'));
});

describe('settings backup duplicate check', () => {
    test('compares against the backup with the newest name, whatever the files\' ctimes', () => {
        // Written newest-first, so the older backup ends up with the newer ctime (as after a copy).
        const newest = path.join(backupsDir, `settings_${handle}_20260926-150503.json`);
        const older = path.join(backupsDir, `settings_${handle}_20260926-150448.json`);
        fs.writeFileSync(newest, '{"newest":true}');
        fs.writeFileSync(older, '{"older":true}');
        // ctime has coarse granularity; re-touch until it has actually moved past the newest backup's.
        while (fs.statSync(older).ctimeMs <= fs.statSync(newest).ctimeMs) {
            fs.utimesSync(older, new Date(), new Date());
        }

        expect(isDuplicateBackup(handle, '{"newest":true}')).toBe(true);
        expect(isDuplicateBackup(handle, '{"older":true}')).toBe(false);
    });
});
