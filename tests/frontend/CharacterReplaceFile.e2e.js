import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';
import { write as writeCardPng } from '../../src/character-card-parser.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const AVATAR = 'Alice.png';
const PARTY_ID = '1700000000001';
const SPRITE = 'joy.png';

const cardV2 = (/** @type {string} */ name, /** @type {string} */ description) => ({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name, description, first_mes: `${name} greets you.`, personality: '', scenario: '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} },
});

/** @returns {{ name: string, mimeType: string, buffer: Buffer }} */
function pngCard() {
    const image = fs.readFileSync(path.join(import.meta.dirname, '../../public/img/ai4.png'));
    return { name: 'replacement.png', mimeType: 'image/png', buffer: writeCardPng(image, JSON.stringify(cardV2('Replacement PNG', 'Replaced from a PNG.'))) };
}

/** @returns {{ name: string, mimeType: string, buffer: Buffer }} */
function jsonCard() {
    return { name: 'replacement.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(cardV2('Replacement JSON', 'Replaced from a JSON.'))) };
}

/**
 * @param {{ name: string, mimeType: string, buffer: Buffer }} card
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
async function serveCard(card) {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': card.mimeType });
        response.end(card.buffer);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    return {
        url: `http://localhost:${port}/${card.name}`,
        close: () => new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); }),
    };
}

/**
 * @param {import('@playwright/test').Page} page
 */
function snapshot(page) {
    return page.evaluate(async ({ avatar, partyId }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const post = async (/** @type {string} */ url, /** @type {object} */ body) => (await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).json();
        const character = await post('/api/characters/get', { avatar_url: avatar });
        const chats = await post('/api/characters/chats', { avatar_url: avatar, simple: true });
        const [group] = await post('/api/groups/batch', { ids: [partyId] });
        return {
            name: character.name,
            description: character.description,
            data: character.data,
            fav: character.fav,
            tags: character.tag_ids,
            thing: character.thing,
            avatar: character.avatar,
            chatIds: chats.map((/** @type {any} */ c) => c.file_id).sort(),
            members: group.members,
        };
    }, { avatar: AVATAR, partyId: PARTY_ID });
}

/** @param {string} dataRoot */
const charactersDir = dataRoot => path.join(dataRoot, 'default-user', 'characters');

/** @param {string} dataRoot */
const cardFiles = dataRoot => fs.readdirSync(charactersDir(dataRoot)).filter(f => f.endsWith('.png')).sort();

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} dataRoot
 */
async function openAlice(page, dataRoot) {
    fs.mkdirSync(path.join(charactersDir(dataRoot), 'Alice'), { recursive: true });
    fs.writeFileSync(path.join(charactersDir(dataRoot), 'Alice', SPRITE), 'sprite');
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    await page.evaluate(async avatar => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, AVATAR);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(AVATAR, { timeout: 10000 });
    await expect(page.locator('#chat .mes').first()).toBeVisible({ timeout: 15000 });
    await page.locator('#chat .mes').evaluateAll(messages => messages.forEach(m => { m.setAttribute('data-before-replace', ''); }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} button
 */
async function chooseReplace(page, button) {
    await page.locator('#char-management-dropdown').selectOption({ label: 'Replace / Update' });
    await page.locator('dialog[open] .popup-button-ok', { hasText: button }).waitFor();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} dataRoot
 * @param {Awaited<ReturnType<typeof snapshot>>} before
 * @param {string} name
 * @param {string} description
 */
async function expectReplaced(page, dataRoot, before, name, description) {
    await expect.poll(async () => (await snapshot(page)).name, { timeout: 15000 }).toBe(name);
    const after = await snapshot(page);
    expect(after.description).toBe(description);
    expect.soft(after.data.first_mes).toBe(`${name} greets you.`);
    expect.soft(after.data.alternate_greetings).toEqual([]);
    expect.soft(after.data.character_book).toBeUndefined();
    expect.soft(after.data.extensions.world).toBeUndefined();
    expect.soft(after.data.extensions.depth_prompt).toBeUndefined();
    expect(after.avatar).toBe(AVATAR);
    expect(after.thing).toBe(before.thing);
    expect(after.chatIds).toEqual(before.chatIds);
    expect(after.members).toEqual(before.members);
    expect(fs.readFileSync(path.join(charactersDir(dataRoot), 'Alice', SPRITE), 'utf8')).toBe('sprite');

    await expect(page.locator('#avatar_url_pole')).toHaveValue(AVATAR);
    await expect(page.locator('#chat .mes').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#chat .mes[data-before-replace]')).toHaveCount(0);
    await expect(page.locator('#chat')).toContainText('Bye.');
}

test.describe('Replace / Update', () => {
    for (const [format, makeCard, description] of /** @type {const} */ ([['PNG', pngCard, 'Replaced from a PNG.'], ['JSON', jsonCard, 'Replaced from a JSON.']])) {
        test(`Replace with File takes a ${format} card and keeps the character's identity, chats, assets and group`, async ({ page, stServer }) => {
            await openAlice(page, stServer.dataRoot);
            const before = await snapshot(page);
            const filesBefore = cardFiles(stServer.dataRoot);
            expect(before.chatIds.length).toBeGreaterThan(0);
            expect(before.members).toContain(AVATAR);

            await chooseReplace(page, 'Replace with File');
            const card = makeCard();
            const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
            await page.locator('dialog[open] .popup-button-ok', { hasText: 'Replace with File' }).click();
            await (await chooser).setFiles(card);

            await expectReplaced(page, stServer.dataRoot, before, `Replacement ${format}`, description);
            expect(cardFiles(stServer.dataRoot)).toEqual(filesBefore);
        });
    }

    test('Replace with URL takes a card from a loopback server with the same guarantees', async ({ page, stServer }) => {
        await openAlice(page, stServer.dataRoot);
        const before = await snapshot(page);
        const filesBefore = cardFiles(stServer.dataRoot);
        const served = await serveCard(pngCard());
        try {
            await chooseReplace(page, 'Replace with URL');
            await page.locator('dialog[open] .popup-button-ok', { hasText: 'Replace with URL' }).click();
            await page.locator('dialog[open] .popup-input').fill(served.url);
            await page.locator('dialog[open] .popup-button-ok').click();

            await expectReplaced(page, stServer.dataRoot, before, 'Replacement PNG', 'Replaced from a PNG.');
            expect(cardFiles(stServer.dataRoot)).toEqual(filesBefore);
        } finally {
            await served.close();
        }
    });
});

const STARTING_GREETINGS = ['Start A', 'Start B', 'Start C'];

/**
 * @param {string[]} greetings the first is the default
 * @returns {{ name: string, mimeType: string, buffer: Buffer }}
 */
function greetingsCard(greetings) {
    const card = cardV2('Greeter', 'Has greetings.');
    card.data.first_mes = greetings[0] ?? '';
    card.data.alternate_greetings = greetings.slice(1);
    return { name: 'greetings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>} the avatar
 */
function createGreeter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return (await response.text()).trim();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openGreeter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async avatar => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<{ stored: string[], held: string[] }>} the greetings as the server stores them and as the page holds them, default first
 */
function greetingsOf(page, avatar) {
    return page.evaluate(async avatar => {
        // @ts-ignore
        const context = stTest.context();
        const response = await fetch('/api/characters/get', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        const card = await response.json();
        const held = context.getCharacterByAvatar(avatar);
        const list = (/** @type {any} */ c) => [c.data.first_mes, ...c.data.alternate_greetings].filter(text => text !== '');
        return { stored: list(card), held: list(held) };
    }, avatar);
}

test.describe('Replace / Update greetings', () => {
    for (const [what, replacement] of /** @type {const} */ ([
        ['more', [...STARTING_GREETINGS, 'Start D', 'Start E']],
        ['different', ['Other A', 'Other B', 'Other C']],
        ['fewer', ['Start B']],
        ['none', []],
    ])) {
        test(`a card with ${what} greetings gives the character exactly the card's greetings`, async ({ page }) => {
            await testSetup.awaitST({ page });
            const avatar = await createGreeter(page, `Greeter ${what}`, STARTING_GREETINGS);
            await openGreeter(page, avatar);
            expect((await greetingsOf(page, avatar)).stored).toEqual(STARTING_GREETINGS);

            await chooseReplace(page, 'Replace with File');
            const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
            await page.locator('dialog[open] .popup-button-ok', { hasText: 'Replace with File' }).click();
            await (await chooser).setFiles(greetingsCard(replacement));

            await expect.poll(async () => (await greetingsOf(page, avatar)).stored, { timeout: 15000 }).toEqual(replacement);
            expect((await greetingsOf(page, avatar)).held).toEqual(replacement);
        });
    }
});

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('Replace with File: a JSON card keeps the character\'s picture, a PNG card brings its own', async ({ page, stServer }) => {
    await testSetup.awaitST({ page });
    const avatar = await createGreeter(page, 'Pictured', STARTING_GREETINGS);
    await openGreeter(page, avatar);
    const picture = () => fs.readFileSync(path.join(charactersDir(stServer.dataRoot), avatar));

    /** @param {{ name: string, mimeType: string, buffer: Buffer }} card */
    const replaceWith = async card => {
        await chooseReplace(page, 'Replace with File');
        const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
        await page.locator('dialog[open] .popup-button-ok', { hasText: 'Replace with File' }).click();
        await (await chooser).setFiles(card);
    };

    const png = { name: 'picture.png', mimeType: 'image/png', buffer: writeCardPng(ONE_PIXEL_PNG, JSON.stringify(cardV2('Pictured', 'From a PNG.'))) };
    await replaceWith(png);
    await expect.poll(async () => (await snapshotOf(page, avatar)).description, { timeout: 15000 }).toBe('From a PNG.');
    expect(picture().equals(png.buffer)).toBe(true);

    await replaceWith(jsonCard());
    await expect.poll(async () => (await snapshotOf(page, avatar)).description, { timeout: 15000 }).toBe('Replaced from a JSON.');
    expect(picture().equals(png.buffer)).toBe(true);
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<{ description: string }>}
 */
function snapshotOf(page, avatar) {
    return page.evaluate(async avatar => {
        // @ts-ignore
        const response = await fetch('/api/characters/get', { method: 'POST', headers: stTest.context().getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        return response.json();
    }, avatar);
}
