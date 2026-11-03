import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 */
async function openNewCharacter(page) {
    const name = `TagAssignStaleReload-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
    await expect.poll(() => page.evaluate(() => stTest.context().characterId), { timeout: 10000 }).not.toBeUndefined();
    return await page.evaluate(() => stTest.context().characters[stTest.context().characterId].avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tag
 */
async function addTag(page, tag) {
    await expect(async () => {
        await page.locator('#tagInput').fill(tag);
        await expect(page.locator('#tagInput')).toHaveValue(tag, { timeout: 500 });
    }).toPass({ timeout: 30000 });
    await page.locator('.ui-autocomplete .ui-menu-item').getByText(tag, { exact: true }).click();
}

/**
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
    return await page.evaluate(async (avatar) => {
        const { tagsStore } = await import('/scripts/tags.js');
        const character = stTest.context().characters.find(c => c.avatar === avatar);
        return (character.tag_ids ?? []).map(id => tagsStore.get(id)?.name);
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
