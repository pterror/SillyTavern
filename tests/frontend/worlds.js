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
    await pane.getByRole('menuitem', { name: 'Import a world…' }).click();
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
