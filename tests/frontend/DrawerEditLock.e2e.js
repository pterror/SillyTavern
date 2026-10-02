import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers } from './frontent-test-utils.js';

// With stacked drawers on, nothing covers what is being edited: a character info field, or a chat message. Another
// layer can still open, behind it; once the edit ends, the edited layer stays where it was.

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Makes a character and opens it in character info.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} Its avatar.
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
    }, `EditLock-${Date.now()}`);
    await page.locator('#charInfoDrawerIcon').click();
    await page.evaluate(async (avatar) => {
        await window['SillyTavern'].getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
    return avatar;
}

/** @param {import('@playwright/test').Locator} layer */
const isCut = layer => layer.evaluate(el => el.dataset.stackCut === 'true');

test.describe('Nothing covers what is being edited', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
    });

    test('a character info field being edited stays on top; another character is refused like a tab', async ({ page }) => {
        await setStackedDrawers(page, true);
        const avatar = await openNewCharacter(page);
        const info = page.locator('#char-info-panel');
        const panel = page.locator('.char_info_tab_panel', { has: page.locator('#description_textarea') });
        await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(panel).toHaveClass(/\bfield_editing\b/);

        // Fullscreen character management opens, but behind character info.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
        await expect.poll(() => isCut(page.locator('#right-nav-panel'))).toBe(true);
        expect(await isCut(info)).toBe(false);

        // Clicking another character is refused: the field's ✓ ✕ flash and no toast.
        await page.locator('#rm_print_characters_block .character_select', { hasText: 'Seraphina' }).first().click();
        await expect(panel).toHaveClass(/\bfield_edit_attention\b/);
        await expect(page.locator('#toast-container .toast-message', { hasText: 'being edited' })).toHaveCount(0);
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);

        // Once the edit ends, character info stays where it was.
        await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();
        await expect(panel).not.toHaveClass(/\bfield_editing\b/);
        await page.waitForFunction(() => !document.querySelector('.field_editing'));
        expect(await isCut(info)).toBe(false);
        await expect.poll(() => isCut(page.locator('#right-nav-panel'))).toBe(true);
    });

    test('the chat stays on top while a message is being edited', async ({ page }) => {
        await setStackedDrawers(page, true);
        await openNewCharacter(page);
        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toHaveClass(/closedDrawer/);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await expect(page.locator('#curEditTextarea')).toHaveCount(1);

        // User Settings opens over the chat's middle, but behind it.
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await expect.poll(() => isCut(page.locator('#user-settings-block'))).toBe(true);
        expect(await isCut(page.locator('#sheld'))).toBe(false);

        // Ending the edit by a click in the chat closes the unpinned drawer, as any click in the chat does.
        await page.locator('#chat .mes[mesid="0"] .mes_edit_cancel').click();
        await expect(page.locator('#curEditTextarea')).toHaveCount(0);
        await expect.poll(() => isCut(page.locator('#sheld'))).toBe(false);
    });
});
