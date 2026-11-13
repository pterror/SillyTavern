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
 * Makes a world as a slash command does, and waits for the page to hold it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {Record<string, unknown>} [entries]
 */
export async function makeWorld(page, name, entries = {}) {
    await page.evaluate(async ({ name, entries }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const made = await fetch('/api/worldinfo/create', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, unique: false, data: { entries } }) });
        if (!made.ok) throw new Error(`making ${name} failed: ${made.status}`);
    }, { name, entries });
    await expect.poll(async () => Object.hasOwn(await heldWorlds(page), name)).toBe(true);
}

/**
 * Sends one of the worldbuilding page's actions, as the page would.
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {unknown} payload
 * @returns {Promise<unknown>}
 */
export async function act(page, type, payload) {
    return page.evaluate(async ({ type, payload }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const response = await fetch('/api/ui/action', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ type, payload }) });
        const text = await response.text();
        return JSON.parse(text.split('\n')[0]);
    }, { type, payload });
}

/**
 * Deletes a world, and waits for the page to drop it.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function deleteWorld(page, name) {
    const held = (await heldWorlds(page))[name];
    if (!held) return;
    await act(page, 'worldbuilding.deleteWorld', { book: held.id });
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
    await expect(page.locator('#Worldbuilding .wb-front-name')).toHaveText(name);
}
