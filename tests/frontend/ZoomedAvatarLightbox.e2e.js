import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Leaves the page on a fresh character's chat holding one message from that character (so it has a
 * clickable .mes .avatar), with every drawer closed.
 * @param {import('@playwright/test').Page} page
 */
async function openChatWithCharacterMessage(page) {
    const name = `ZoomedAvatarLightbox-${Date.now()}`;
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
}

test.describe('Zoomed avatar lightbox', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await openChatWithCharacterMessage(page);
        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
    });

    test('clicking the zoomed avatar shows its image in the lightbox', async ({ page }) => {
        const zoomedImage = page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img');
        await expect(zoomedImage).toHaveAttribute('src', /.+/);
        const src = await zoomedImage.getAttribute('src');
        await expect(zoomedImage).toHaveCSS('cursor', 'pointer');

        await zoomedImage.click();

        const enlarged = page.locator('.img_enlarged_container img.img_enlarged');
        await expect(enlarged).toBeVisible();
        await expect(enlarged).toHaveAttribute('src', src);
        await expect(page.locator('.zoomed_avatar[forChar]')).toHaveCount(1);
    });

    test('the close button closes the zoomed avatar without showing the lightbox', async ({ page }) => {
        await page.locator('.zoomed_avatar[forChar]').hover();
        await page.locator('.zoomed_avatar[forChar] .dragClose').click();

        await expect(page.locator('.zoomed_avatar[forChar]')).toHaveCount(0);
        await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
    });

    test('the drag handle does not show the lightbox', async ({ page }) => {
        // The handle is only displayed with Moving UI on; the click is dispatched on it directly.
        await page.locator('.zoomed_avatar[forChar] .drag-grabber').evaluate(el => el.click());

        await expect(page.locator('.zoomed_avatar[forChar]')).toHaveCount(1);
        await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
    });
});
