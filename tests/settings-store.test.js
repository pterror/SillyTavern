import { describe, test, expect, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/settings-store.js')} */
let store;
let tempDir;
let directories;

beforeEach(async () => {
    if (!store) {
        store = await import('../src/settings-store.js');
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-settings-store-test-'));
    directories = { root: tempDir };
});

function settingsDir() {
    return path.join(tempDir, 'settings');
}

function legacyFile() {
    return path.join(tempDir, 'settings.json');
}

describe('settings-store: writeSettingsKeys never touches unrelated key files', () => {
    test('writing one top-level key does not rewrite another key\'s on-disk file', () => {
        store.writeAllSettings(directories, { power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });

        const extensionSettingsFile = path.join(settingsDir(), 'extension_settings.json');
        const before = fs.statSync(extensionSettingsFile).mtimeMs;

        // Force the clock forward enough that a real rewrite would produce a detectably different mtime on any
        // filesystem's mtime resolution (some are as coarse as ~1s).
        fs.utimesSync(extensionSettingsFile, new Date(0), new Date(0));

        store.writeSettingsKeys(directories, { power_user: { theme: 'light' } });

        const after = fs.statSync(extensionSettingsFile).mtimeMs;
        expect(after).toBe(new Date(0).getTime());
        expect(after).not.toBe(before);
        expect(store.readAllSettings(directories).extension_settings).toEqual({ foo: 1 });
    });

    test('writing one top-level key creates only that key\'s file, not a monolithic settings.json', () => {
        store.writeAllSettings(directories, { power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        store.writeSettingsKeys(directories, { power_user: { theme: 'light' } });

        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(fs.readdirSync(settingsDir()).sort()).toEqual(['extension_settings.json', 'power_user.json']);
    });

    test('a dotted-path write only rewrites its own top-level key\'s file', () => {
        store.writeAllSettings(directories, { power_user: { theme: 'dark', font_scale: 1 }, oai_settings: { model: 'gpt' } });

        const oaiFile = path.join(settingsDir(), 'oai_settings.json');
        fs.utimesSync(oaiFile, new Date(0), new Date(0));

        store.writeSettingsKeys(directories, { 'power_user.font_scale': 2 });

        expect(fs.statSync(oaiFile).mtimeMs).toBe(new Date(0).getTime());
        expect(store.readAllSettings(directories)).toEqual({
            power_user: { theme: 'dark', font_scale: 2 },
            oai_settings: { model: 'gpt' },
        });
    });
});

describe('settings-store: legacy migration', () => {
    test('a legacy monolithic settings.json is transparently split into per-key files on first read', () => {
        fs.writeFileSync(legacyFile(), JSON.stringify({ power_user: { theme: 'dark' }, main_api: 'kobold' }, null, 4), 'utf8');

        const result = store.readAllSettings(directories);

        expect(result).toEqual({ power_user: { theme: 'dark' }, main_api: 'kobold' });
        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(fs.readdirSync(settingsDir()).sort()).toEqual(['main_api.json', 'power_user.json']);
    });

    test('a legacy monolithic settings.json is transparently split on first write too', () => {
        fs.writeFileSync(legacyFile(), JSON.stringify({ power_user: { theme: 'dark' }, main_api: 'kobold' }, null, 4), 'utf8');

        store.writeSettingsKeys(directories, { main_api: 'openai' });

        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(store.readAllSettings(directories)).toEqual({ power_user: { theme: 'dark' }, main_api: 'openai' });
    });

    test('no settings at all yet reads back as an empty object', () => {
        expect(store.settingsExist(directories)).toBe(false);
        expect(store.readAllSettings(directories)).toEqual({});
        expect(store.readAllSettingsAsJson(directories)).toBe('{}');
    });
});

describe('settings-store: writeAllSettings full replace', () => {
    test('removes a key\'s file entirely when that key is absent from the new full object', () => {
        store.writeAllSettings(directories, { power_user: { theme: 'dark' }, extension_settings: { foo: 1 } });
        store.writeAllSettings(directories, { power_user: { theme: 'dark' } });

        expect(store.readAllSettings(directories)).toEqual({ power_user: { theme: 'dark' } });
        expect(fs.existsSync(path.join(settingsDir(), 'extension_settings.json'))).toBe(false);
    });
});

describe('settings-store: deleteAllSettings', () => {
    test('removes both the sharded directory and any legacy file', () => {
        store.writeAllSettings(directories, { power_user: { theme: 'dark' } });
        expect(fs.existsSync(settingsDir())).toBe(true);

        store.deleteAllSettings(directories);

        expect(fs.existsSync(settingsDir())).toBe(false);
        expect(fs.existsSync(legacyFile())).toBe(false);
        expect(store.settingsExist(directories)).toBe(false);
    });
});

describe('settings-store: isValidSettingsKey / key-name safety', () => {
    test('a key literally named "__proto__" is handled as an ordinary filename, never a prototype swap', () => {
        // Object literal syntax `{ '__proto__': x }` doesn't create an own property at all (it sets the
        // object's prototype) - going through JSON.parse, the way an Express request body actually arrives,
        // is what produces a genuine own enumerable property named '__proto__', same as a real client request.
        const keys = JSON.parse('{"__proto__": {"polluted": true}}');
        expect(() => store.writeSettingsKeys(directories, keys)).not.toThrow();

        const result = store.readAllSettings(directories);
        // Object.getOwnPropertyDescriptor, unlike `result.__proto__`, can't be fooled by the same special-case -
        // this is the actual assertion that it landed as a real own property, not a prototype swap.
        const descriptor = Object.getOwnPropertyDescriptor(result, '__proto__');
        expect(descriptor).toBeDefined();
        expect(descriptor.enumerable).toBe(true);
        expect(descriptor.value).toEqual({ polluted: true });
        expect(Object.keys(result)).toContain('__proto__');
    });

    test('rejects a path-traversal-shaped key outright', () => {
        expect(() => store.writeSettingsKeys(directories, { '../evil': 1 })).toThrow();
        expect(() => store.writeSettingsKeys(directories, { 'a/../../evil': 1 })).toThrow();
    });

    test('isValidSettingsKey accepts real settings keys and rejects unsafe ones', () => {
        for (const key of ['power_user', 'extension_settings', 'oai_settings', 'world_info_settings', 'active_character']) {
            expect(store.isValidSettingsKey(key)).toBe(true);
        }
        for (const key of ['../evil', 'a/b', '', 'a.b', 'a b']) {
            expect(store.isValidSettingsKey(key)).toBe(false);
        }
    });
});
