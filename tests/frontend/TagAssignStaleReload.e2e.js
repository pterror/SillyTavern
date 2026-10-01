import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * Creates and opens a throwaway character, returning its avatar key.
 * @param {import('@playwright/test').Page} page
 */
async function openNewCharacter(page) {
    const name = `TagAssignStaleReload-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
    // A row whose character the page doesn't hold is read from the server before it opens.
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().characterId), { timeout: 10000 }).not.toBeUndefined();
    return await page.evaluate(() => SillyTavern.getContext().characters[SillyTavern.getContext().characterId].avatar);
}

/**
 * Adds a new tag to the open character through the tag input.
 * @param {import('@playwright/test').Page} page
 * @param {string} tag
 */
async function addTag(page, tag) {
    // The chat that opens with the character takes the focus when it has loaded; text filled before that is lost.
    await expect(async () => {
        await page.locator('#tagInput').fill(tag);
        await expect(page.locator('#tagInput')).toHaveValue(tag, { timeout: 500 });
    }).toPass({ timeout: 30000 });
    await page.locator('.ui-autocomplete .ui-menu-item').getByText(tag, { exact: true }).click();
}

/**
 * Starts a reload of the character whose server response is read right away but handed to the page only
 * once `release()` is called, so the page receives data older than anything done in between.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function startStaleReload(page, avatar) {
    let release;
    const released = new Promise(resolve => release = resolve);
    let read;
    const serverRead = new Promise(resolve => read = resolve);
    await page.route('**/api/characters/get', async (route) => {
        const response = await route.fetch();
        read();
        await released;
        await route.fulfill({ response });
    });
    await page.evaluate(async (avatar) => {
        const { getOneCharacter } = await import('./scripts/character-list.js');
        window['staleReload'] = getOneCharacter(avatar);
    }, avatar);
    await serverRead;
    return {
        finish: async () => {
            release();
            await page.evaluate(() => window['staleReload']);
            await page.unroute('**/api/characters/get');
        },
    };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function residentTagNames(page, avatar) {
    return await page.evaluate((avatar) => {
        const context = SillyTavern.getContext();
        const character = context.characters.find(c => c.avatar === avatar);
        return (character.tag_ids ?? []).map(id => context.tags.find(t => t.id === id)?.name);
    }, avatar);
}

test.describe('tag assignment vs a stale character reload', () => {
    test.beforeEach(testSetup.awaitST);

    test('a reload read before an assignment was saved does not drop it', async ({ page }) => {
        const avatar = await openNewCharacter(page);
        const reload = await startStaleReload(page, avatar);

        const assigned = page.waitForResponse(response => response.url().endsWith('/api/tags/assign'));
        await addTag(page, 'stale-reload-saved');
        await assigned;

        await reload.finish();
        expect(await residentTagNames(page, avatar)).toContain('stale-reload-saved');
    });

    test('a reload landing while an assignment is still being saved does not drop it', async ({ page }) => {
        const avatar = await openNewCharacter(page);
        const reload = await startStaleReload(page, avatar);

        let releaseAssign;
        const assignReleased = new Promise(resolve => releaseAssign = resolve);
        let assignSent;
        const assignHeld = new Promise(resolve => assignSent = resolve);
        await page.route('**/api/tags/assign', async (route) => {
            assignSent();
            await assignReleased;
            await route.continue();
        });
        await addTag(page, 'stale-reload-in-flight');
        await assignHeld;

        await reload.finish();
        expect(await residentTagNames(page, avatar)).toContain('stale-reload-in-flight');

        const assigned = page.waitForResponse(response => response.url().endsWith('/api/tags/assign'));
        releaseAssign();
        await assigned;
        expect(await residentTagNames(page, avatar)).toContain('stale-reload-in-flight');
    });
});
