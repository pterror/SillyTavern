import { beforeAll, afterAll, describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @type {typeof import('../src/message-tree-db.js')} */
let tree;
/** @type {any} */
let directories;
let tempDir;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    tree = await import('../src/message-tree-db.js');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-opening-choice-test-'));
    directories = { root: tempDir, characters: path.join(tempDir, 'characters'), chats: path.join(tempDir, 'chats') };
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.chats, { recursive: true });
});

afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
const nextOwner = () => `choice-owner-${++counter}.png`;
/** @param {string} mes */
const greeting = mes => ({ name: 'Char', is_user: false, is_system: false, send_date: 'd0', mes, extra: {} });
/** @param {string[]} texts */
const card = texts => texts.map(greeting);

/**
 * @param {string} owner
 * @param {string[]} texts
 */
async function shown(owner, texts) {
    const result = await tree.getOpeningAlternatives(directories, owner, {}, card(texts));
    return { chosen: result.default_chosen, mes: result.alternatives[result.default_index - result.offset]?.mes, stored: result.stored };
}

describe('a card greeting the chat was switched to', () => {
    test('is the default the openings name, without giving it a row', async () => {
        const owner = nextOwner();
        const texts = ['Zero', 'One', 'Two'];
        expect(await shown(owner, texts)).toEqual({ chosen: false, mes: 'Zero', stored: 0 });
        expect(await tree.chooseCardOpening(directories, owner, 'Two', 2)).toBe(true);
        expect(await shown(owner, texts)).toEqual({ chosen: true, mes: 'Two', stored: 0 });
    });

    test('is replaced when one of the stored openings is selected, and wins over it when chosen after', async () => {
        const owner = nextOwner();
        const texts = ['Zero', 'One', 'Two'];
        const ensured = await tree.addOpeningAlternatives(directories, owner, [greeting('Zero')]);
        expect(ensured.ok).toBe(true);
        const zeroId = ensured.node_ids[0];

        await tree.chooseCardOpening(directories, owner, 'One', 1);
        expect(await shown(owner, texts)).toEqual({ chosen: true, mes: 'One', stored: 1 });

        expect(await tree.selectDefaultChild(directories, zeroId)).toBe(true);
        expect(await shown(owner, texts)).toEqual({ chosen: false, mes: 'Zero', stored: 1 });
    });

    test('whose text changed is stood in for by the greeting now at its card position, clamped', async () => {
        const owner = nextOwner();
        await tree.chooseCardOpening(directories, owner, 'Two', 2);
        expect(await shown(owner, ['Zero', 'One', 'Two edited'])).toEqual({ chosen: true, mes: 'Two edited', stored: 0 });
        expect(await shown(owner, ['Zero', 'One'])).toEqual({ chosen: true, mes: 'One', stored: 0 });
    });

});
