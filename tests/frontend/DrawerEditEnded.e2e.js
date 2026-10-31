import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function openNewCharacter(page) {
    const avatar = await page.evaluate(async (name) => {
        const context = window['SillyTavern'].getContext();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('description', 'A description.');
        form.set('first_mes', 'Hello there.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, `EditEnded-${Date.now()}`);
    await page.locator('#charInfoDrawerIcon').click();
    await page.evaluate(async (avatar) => {
        await window['SillyTavern'].getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
    if (await page.locator('#right-nav-panel').evaluate(el => el.classList.contains('openDrawer'))) {
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
    }
}

/** @param {import('@playwright/test').Locator} layer */
const isCut = layer => layer.evaluate(el => el.dataset.stackCut === 'true');

test.describe('A drawer brought forward after a field edit goes over character info', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
    });

    test('DR12: character management opened after the edit is confirmed', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openNewCharacter(page);
        const info = page.locator('#char-info-panel');
        const panel = page.locator('.char_info_tab_panel', { has: page.locator('#description_textarea') });
        await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(panel).toHaveClass(/\bfield_editing\b/);
        await page.keyboard.type('More. ');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        await expect(panel).not.toHaveClass(/\bfield_editing\b/);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
        await expect.poll(() => isCut(info)).toBe(true);
        expect(await isCut(page.locator('#right-nav-panel'))).toBe(false);
    });

    test('DR12: character management opened while the confirmed edit is still saving', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openNewCharacter(page);
        const info = page.locator('#char-info-panel');
        const panel = page.locator('.char_info_tab_panel', { has: page.locator('#description_textarea') });
        await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(panel).toHaveClass(/\bfield_editing\b/);
        await page.keyboard.type('More. ');

        /** @type {() => void} */
        let release = () => {};
        const held = new Promise(resolve => { release = () => resolve(undefined); });
        await page.route('**/api/characters/merge-attributes', async (route) => {
            await held;
            await route.continue();
        });
        const saved = page.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes'));
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
        release();
        await saved;
        await expect(panel).not.toHaveClass(/\bfield_editing\b/);
        await expect.poll(() => isCut(info)).toBe(true);
        expect(await isCut(page.locator('#right-nav-panel'))).toBe(false);
    });

    test('while a field is being edited, character management does not open: it is for picking a character, which the edit refuses', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openNewCharacter(page);
        const panel = page.locator('.char_info_tab_panel', { has: page.locator('#description_textarea') });
        await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(panel).toHaveClass(/\bfield_editing\b/);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(panel).toHaveClass(/\bfield_edit_attention\b/);
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
        await expect(panel).toHaveClass(/\bfield_editing\b/);
    });

    test('character management open under a field being edited closes on its icon', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openNewCharacter(page);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
        const panel = page.locator('.char_info_tab_panel', { has: page.locator('#description_textarea') });
        await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(panel).toHaveClass(/\bfield_editing\b/);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
        await expect(panel).toHaveClass(/\bfield_editing\b/);
    });
});
