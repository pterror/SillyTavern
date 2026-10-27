import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The import sources' URL parsing: a RisuRealm link with a query string or fragment (a shared link's) still names
// its character, and a Perchance card's stored source link (its `data` the slug alone) still parses, so "Replace
// from URL" works on cards imported from Perchance.

/** @type {typeof import('../src/endpoints/content-manager.js')} */
let contentManager;
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-content-manager-urls-'));
jest.unstable_mockModule('../src/server-directory.js', () => ({ serverDirectory: fixtureRoot }));

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    globalThis.DATA_ROOT = fixtureRoot;
    contentManager = await import('../src/endpoints/content-manager.js');
});

afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('RisuRealm URLs', () => {
    const id = '7adb0ed8d81855c820b3506980fb40f054ceef010ff0c4bab73730c0ebe92279';
    test.each([
        [`https://realm.risuai.net/character/${id}`, id],
        [`https://realm.risuai.net/character/${id}/`, id],
        [`https://realm.risuai.net/character/${id}?ref=share`, id],
        [`https://realm.risuai.net/character/${id}#top`, id],
        ['https://realm.risuai.net/character/7adb0ed8-d818-55c8-20b3-506980fb40f0', '7adb0ed8-d818-55c8-20b3-506980fb40f0'],
        [`https://realm.risuai.net/other/${id}`, null],
        [`https://example.com/character/${id}`, null],
        ['not a url', null],
    ])('%s', (url, expected) => {
        expect(contentManager.parseRisuUrl(url)).toBe(expected);
    });
});

describe('Perchance slugs', () => {
    const slug = '6903e991c90fd1dba52c036d917e99c6.gz';
    test.each([
        [`https://perchance.org/ai-character-chat?data=Personality_Advisor~${slug}`, slug],
        [`Personality_Advisor~${slug}`, slug],
        // The link a stored card's source makes (character-list.js getCharacterSource).
        [`https://perchance.org/ai-character-chat?data=${slug}`, slug],
        ['https://perchance.org/ai-character-chat', ''],
        ['https://perchance.org/ai-character-chat?data=nothing', ''],
    ])('%s', (url, expected) => {
        expect(contentManager.parsePerchanceSlug(url)).toBe(expected);
    });
});
