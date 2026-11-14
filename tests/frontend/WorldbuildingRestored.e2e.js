import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteCharacter, deleteWorld, heldWorlds, makeCharacter, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {number} uid
 */
async function storedEntry(page, name, uid) {
    return page.evaluate(async ({ name, uid }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, uid }) });
        return (await read.json()).entry;
    }, { name, uid });
}

test.describe('what the old lorebook could do, on the worlds page', () => {
    test.beforeEach(testSetup.awaitST);

    test('an entry is limited to some characters from its "In the prompt" sentence, stored as upstream names them', async ({ page }) => {
        test.setTimeout(90_000);
        const who = unique('Wren');
        const avatar = await makeCharacter(page, who);
        const name = unique('Filtered');
        try {
            await makeWorld(page, name, { 0: { uid: 0, key: ['lamp'], comment: 'Lamp', content: 'A lamp.', displayIndex: 0 } });
            await pane(page).locator('.wb-card-open', { hasText: 'Lamp' }).click();
            await pane(page).getByRole('button', { name: 'In the prompt' }).click();
            const sentence = pane(page).getByRole('dialog', { name: 'In the prompt' });
            await sentence.getByRole('button', { name: '+ More' }).click();
            await sentence.locator('.wb-choice', { hasText: 'Only for some characters' }).click();
            await sentence.getByRole('textbox', { name: 'Add a character or a tag' }).fill(who.slice(0, 8));
            await sentence.getByRole('option', { name: who }).click();
            await expect(sentence.locator('.wb-filter')).toContainText(`Only for ${who}`);
            const stem = avatar.replace(/\.[^.]+$/, '');
            await expect.poll(async () => (await storedEntry(page, name, 0)).characterFilter).toEqual({ isExclude: false, names: [stem], tags: [] });
            await sentence.getByRole('button', { name: 'Only for' }).click();
            await sentence.getByRole('option', { name: 'Not for these characters' }).click();
            await expect.poll(async () => (await storedEntry(page, name, 0)).characterFilter.isExclude).toBe(true);
            await sentence.getByRole('button', { name: `Take ${who} out` }).click();
            await expect.poll(async () => (await storedEntry(page, name, 0)).characterFilter.names).toEqual([]);
            await page.keyboard.press('Escape');
        } finally {
            await deleteWorld(page, name);
            await deleteCharacter(page, avatar);
        }
    });

    test('a character\'s own lorebook is removed from the character from the world switcher', async ({ page }) => {
        const who = unique('Keeper');
        const avatar = await makeCharacter(page, who, {
            character_book: { name: 'Keeper book', extensions: {}, entries: [{ id: 0, keys: ['lighthouse'], content: 'The keeper is Ida.', enabled: true, insertion_order: 0, extensions: {} }] },
        });
        try {
            await testSetup.awaitST({ page });
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await page.locator('#char-management-dropdown').selectOption({ label: 'View/Edit Embedded Lore' });
            await expect(pane(page).locator('h1.wb-front-name')).toHaveText('Keeper book');
            await pane(page).getByRole('button', { name: 'Switch world' }).click();
            await pane(page).getByRole('menuitem', { name: `Remove from ${who}` }).click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(pane(page).locator('h1.wb-front-name')).not.toHaveText('Keeper book');
            await expect.poll(() => page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('/scripts/request-headers.js');
                const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
                return (await response.json()).data?.character_book ?? null;
            }, avatar)).toBeNull();
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('a world imported under a name already taken comes in beside it under a free name', async ({ page }) => {
        const name = unique('Twice');
        await makeWorld(page, name, { 0: { uid: 0, key: ['a'], content: 'First.', displayIndex: 0 } });
        const chooser = page.waitForEvent('filechooser');
        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        await pane(page).getByRole('menuitem', { name: 'Import a world…' }).click();
        await (await chooser).setFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ entries: { 0: { uid: 0, key: ['b'], content: 'Second.', displayIndex: 0 } } })) });
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(`${name} (1)`);
        await expect(pane(page).locator('.wb-card-open', { hasText: 'Second.' })).toBeVisible();
        await expect.poll(async () => Object.keys(await heldWorlds(page)).filter(n => n.startsWith(name)).sort()).toEqual([name, `${name} (1)`]);
        await deleteWorld(page, `${name} (1)`);
        await deleteWorld(page, name);
    });
});
