import { expect } from '@playwright/test';

/**
 * The worlds as the page holds them, by name: their ids and whether each is used in every chat.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, { id: string, usedInEveryChat: boolean }>>}
 */
export async function heldWorlds(page) {
    return page.evaluate(async () => {
        const { worlds } = await import('/scripts/world-links.js');
        return Object.fromEntries((worlds() ?? []).map(world => [world.name, { id: world.id, usedInEveryChat: world.usedInEveryChat }]));
    });
}

/**
 * Imports a world from the world switcher, which shows it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {Record<string, unknown>} [entries]
 * @param {Record<string, unknown>} [more] the world file's other fields
 */
export async function makeWorld(page, name, entries = {}, more = {}) {
    const pane = page.locator('#Worldbuilding');
    if (!await pane.isVisible()) await page.locator('#WIDrawerIcon').click();
    await pane.getByRole('button', { name: 'Switch world' }).click();
    const chooser = page.waitForEvent('filechooser');
    await pane.getByRole('menuitem', { name: 'Import world…' }).click();
    await (await chooser).setFiles({ name: `${name}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...more, entries })) });
    await expect(pane.locator('h1.wb-front-name')).toHaveText(name);
    await expect.poll(async () => Object.hasOwn(await heldWorlds(page), name)).toBe(true);
}

/**
 * Deletes a world from the world switcher, and waits for the page to drop it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function deleteWorld(page, name) {
    if (!Object.hasOwn(await heldWorlds(page), name)) return;
    await openWorld(page, name);
    const pane = page.locator('#Worldbuilding');
    await pane.getByRole('button', { name: 'Switch world' }).click();
    await pane.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.locator('dialog[open] .popup-button-ok').click();
    await expect.poll(async () => Object.hasOwn(await heldWorlds(page), name)).toBe(false);
}

/**
 * Opens the worlds pane on a world by its name.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function openWorld(page, name) {
    await page.evaluate(async (name) => {
        const { openWorld } = await import('/scripts/world-links.js');
        openWorld(name);
    }, name);
    await expect(page.locator('#Worldbuilding h1.wb-front-name')).toHaveText(name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {Record<string, unknown>} [more]
 * @returns {Promise<string>} the character's avatar
 */
export async function makeCharacter(page, name, more = {}) {
    return page.evaluate(async ({ name, more }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name, extensions: {}, ...more } };
        const form = new FormData();
        form.set('ch_name', name);
        form.set('fav', 'false');
        form.set('json_data', JSON.stringify(card));
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, more });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
export async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        await fetch('/api/characters/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}
