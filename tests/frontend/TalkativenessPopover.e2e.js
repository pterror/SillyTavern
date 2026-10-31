import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<any>}
 */
async function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl }) });
        return response.json();
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createAndOpenCharacter(page, name) {
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    const createResponse = page.waitForResponse(response => response.url().endsWith('/api/characters/create'));
    await page.locator('#create_button_label').click();
    const avatar = await (await createResponse).text();
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-menu-type', 'character_edit');
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: true }) });
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 */
function isPopoverOpen(page) {
    return page.locator('#talkativeness_div').evaluate(el => el.matches(':popover-open'));
}

for (const path of ['css-anchor', 'js-fallback']) {
    test.describe(`talkativeness popover (${path})`, () => {
        test.beforeEach(async ({ page }) => {
            if (path === 'js-fallback') {
                await page.addInitScript(() => {
                    const supports = CSS.supports.bind(CSS);
                    // @ts-ignore
                    CSS.supports = (...args) => (String(args[0]).startsWith('anchor-name') ? false : supports(...args));
                });
            }
        });
        test.beforeEach(testSetup.awaitST);

        test('opens anchored below the button, stays non-modal, saves the slider, and closes on outside click and Escape', async ({ page }) => {
            const avatar = await createAndOpenCharacter(page, `TalkativenessPopover-${path}-${Date.now()}`);
            try {
                const button = page.locator('#talkativeness_button');
                const popover = page.locator('#talkativeness_div');

                const usesCssAnchor = await popover.evaluate(el => el.classList.contains('talkativeness_anchored'));
                expect(usesCssAnchor).toBe(path === 'css-anchor');

                await button.click();
                expect(await isPopoverOpen(page)).toBe(true);
                await expect(popover).toBeVisible();
                const buttonBox = await button.boundingBox();
                const popoverBox = await popover.boundingBox();
                expect(Math.abs(popoverBox.y - (buttonBox.y + buttonBox.height))).toBeLessThanOrEqual(1);
                expect(Math.abs((popoverBox.x + popoverBox.width) - (buttonBox.x + buttonBox.width))).toBeLessThanOrEqual(1);

                expect(await page.locator('dialog[open]').count()).toBe(0);
                await chatBox(page).fill('still interactive');
                await expect(page.locator('#send_textarea')).toHaveValue('still interactive');
                expect(await isPopoverOpen(page)).toBe(true);
                await chatBox(page).fill('');

                await page.locator('#talkativeness_slider').press('ArrowRight');
                await expect(page.locator('#talkativeness_slider')).toHaveValue('0.55');
                await expect.poll(async () => Number((await fetchStoredCharacter(page, avatar)).data.extensions.talkativeness), { timeout: 10000 }).toBe(0.55);

                await page.locator('#creatorInfoWrapper h4').first().click();
                expect(await isPopoverOpen(page)).toBe(false);
                await expect(popover).toBeHidden();

                await button.click();
                expect(await isPopoverOpen(page)).toBe(true);
                await button.click();
                expect(await isPopoverOpen(page)).toBe(false);

                await page.evaluate(() => {
                    // @ts-ignore
                    window.__escapesAtDocument = 0;
                    // @ts-ignore
                    $(document).on('keydown.talkativenessSpec', (e) => { if (e.key === 'Escape') window.__escapesAtDocument++; });
                });
                await button.click();
                expect(await isPopoverOpen(page)).toBe(true);
                await page.keyboard.press('Escape');
                expect(await isPopoverOpen(page)).toBe(false);
                // @ts-ignore
                expect(await page.evaluate(() => window.__escapesAtDocument)).toBe(0);
                await expect(page.locator('#delete_button')).toBeVisible();

                await button.click();
                expect(await isPopoverOpen(page)).toBe(true);
                await expect(popover).toBeVisible();
                await page.keyboard.press('Escape');
                expect(await isPopoverOpen(page)).toBe(false);

                await page.keyboard.press('Escape');
                // @ts-ignore
                expect(await page.evaluate(() => window.__escapesAtDocument)).toBe(1);
                // @ts-ignore
                await page.evaluate(() => $(document).off('keydown.talkativenessSpec'));
            } finally {
                await deleteCharacter(page, avatar);
            }
        });
    });
}
