import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

// A new data root shows a welcome popup partway through startup; startup finishes once it is answered.
async function awaitAppReady(page) {
    const okButton = page.locator('.popup-button-ok');
    const shown = await okButton.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    if (shown) {
        await okButton.first().click();
    }
    await okButton.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

// Pins are toggled through the checkbox's own click handler; the checkbox itself is styled out of view.
async function setPin(page, pinId, pinned) {
    const pin = page.locator(pinId);
    if (await pin.isChecked() !== pinned) {
        await pin.evaluate(el => el.click());
    }
}

/**
 * Leaves the page on a fresh character's chat holding one message from that character (so it has a
 * clickable .mes .avatar), with every drawer closed.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} The character's name.
 */
async function openChatWithCharacterMessage(page) {
    const name = `DrawerFrontOrder-${Date.now()}`;
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').evaluate(el => el.click());
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
    const sendTextarea = page.locator('#send_textarea');
    await sendTextarea.fill(`/sendas name="${name}" hello`);
    // Enter can go unhandled while the freshly selected chat loads; the text stays in the box until it is sent.
    await expect(async () => {
        if (await sendTextarea.inputValue()) {
            await sendTextarea.press('Enter');
        }
        await expect(page.locator('#chat .mes .avatar').first()).toBeVisible({ timeout: 2000 });
    }).toPass();
    // A click on the chat closes every unpinned drawer.
    await page.locator('#chat').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#right-nav-panel')).toBeHidden();
    await expect(page.locator('#char-info-panel')).toBeHidden();
    return name;
}

test.describe('Drawer front order', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('character info brought forward over character management uncovers the zoomed avatar', async ({ page }) => {
        await openChatWithCharacterMessage(page);
        // Both pinned, so the avatar click below doesn't just close them; character management in front.
        await page.locator('#charInfoDrawerIcon').click();
        await setPin(page, '#charInfo_button_panel_pin', true);
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await expect(page.locator('#char-info-panel')).toBeHidden();

        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
    });

    test('closing character management uncovers the zoomed avatar', async ({ page }) => {
        await openChatWithCharacterMessage(page);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
    });

    test('character management comes back in one click after switching character', async ({ page }) => {
        const name = await openChatWithCharacterMessage(page);
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('.character_select', { hasText: name }).first().click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });

    test('API connections opened over pinned fullscreen character management is on top', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();

        await page.locator('#API-status-top').click();
        const apiBlock = page.locator('#rm_api_block');
        await expect(apiBlock).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
        // Visible alone doesn't mean on top: the element under the drawer's center must be the drawer's own.
        await expect.poll(() => apiBlock.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        })).toBe(true);
    });

    test('pinned character management stays open after reload and one click closes it', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel')).toBeVisible();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#right-nav-panel')).toBeVisible();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
    });

    test('pinned character info opened by selecting a character stays open after reload', async ({ page }) => {
        const name = await openChatWithCharacterMessage(page);
        await page.locator('#charInfoDrawerIcon').click();
        await setPin(page, '#charInfo_button_panel_pin', true);
        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('.character_select', { hasText: name }).first().click();
        await expect(page.locator('#char-info-panel')).toBeVisible();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#char-info-panel')).toBeVisible();
    });

    test('pinned character management closed before reload stays closed', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });
});
