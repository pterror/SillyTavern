import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** @param {import('@playwright/test').Page} page */
async function openDrawer(page) {
    const drawer = page.locator('#Backgrounds');
    if (!(await drawer.evaluate(el => el.classList.contains('openDrawer')))) await page.locator('#backgrounds-drawer-toggle').click();
    await expect(drawer).toHaveClass(/openDrawer/);
    await expect(page.locator('#bg_menu_content .bg_example').first()).toBeVisible();
    await expect.poll(() => drawer.evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} file
 */
const systemThumb = (page, file) => page.locator(`#bg_menu_content .bg_example[bgfile="${file}"]`);

/** @param {import('@playwright/test').Page} page */
const shownBackground = page => page.locator('#bg1').evaluate(el => decodeURIComponent(el.style.backgroundImage));

/**
 * @param {import('@playwright/test').Page} page
 */
async function anotherBackground(page) {
    const files = await page.locator('#bg_menu_content .bg_example:not(.selected-background)').evaluateAll(els => els.map(el => el.getAttribute('bgfile')));
    const file = files.find(f => f && !f.startsWith('_'));
    if (!file) throw new Error('No other background to pick');
    return file;
}

/**
 * @param {import('@playwright/test').Locator} thumb
 * @param {string} action
 */
async function thumbAction(thumb, action) {
    await thumb.hover();
    await thumb.locator(`.jg-button[data-action="${action}"]`).click();
}

/** @param {import('@playwright/test').Page} page */
const dialog = page => page.locator('dialog.popup[open]');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

test.describe('backgrounds', () => {
    test.beforeEach(testSetup.awaitST);

    test('a picked background shows behind the chat, in the user\'s other tab without a reload, and after one', async ({ page }) => {
        await openDrawer(page);
        const file = await anotherBackground(page);
        await systemThumb(page, file).click();
        await expect(systemThumb(page, file)).toHaveClass(/selected-background/);
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${file}`);

        const other = await page.context().newPage();
        await testSetup.awaitST({ page: other });
        await expect.poll(() => shownBackground(other)).toContain(`backgrounds/${file}`);

        const next = await anotherBackground(page);
        await systemThumb(page, next).click();
        await expect.poll(() => shownBackground(other), { timeout: 10000 }).toContain(`backgrounds/${next}`);
        await other.close();

        await page.reload();
        await testSetup.awaitST({ page });
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${next}`);
    });

    test('a chat locked to a background shows it; another chat shows the user\'s', async ({ page }) => {
        const cara = await createCharacter(page, `BgLockA-${Date.now()}`);
        const bea = await createCharacter(page, `BgLockB-${Date.now()}`);
        await openCharacter(page, cara);
        await openDrawer(page);
        const users = await page.locator('#bg_menu_content .bg_example.selected-background').getAttribute('bgfile');
        const locked = await anotherBackground(page);
        await thumbAction(systemThumb(page, locked), 'lock');
        await expect(systemThumb(page, locked)).toHaveClass(/locked-background/);
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${locked}`);

        await openCharacter(page, bea);
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${users}`);
        await openCharacter(page, cara);
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${locked}`);

        await openDrawer(page);
        await thumbAction(systemThumb(page, locked), 'unlock');
        await expect.poll(() => shownBackground(page)).toContain(`backgrounds/${users}`);
    });

    test('an uploaded background becomes the user\'s, and can be renamed and deleted', async ({ page }) => {
        await openDrawer(page);
        const name = `e2e-up-${Date.now()}`;
        await page.locator('#add_bg_button').setInputFiles({ name: `${name}.png`, mimeType: 'image/png', buffer: PNG });
        await expect(systemThumb(page, `${name}.png`)).toHaveClass(/selected-background/);

        await thumbAction(systemThumb(page, `${name}.png`), 'edit');
        await dialog(page).locator('.popup-input').fill(`${name}-renamed`);
        await dialog(page).locator('.popup-button-ok').click();
        await expect(systemThumb(page, `${name}-renamed.png`)).toHaveClass(/selected-background/);
        await expect(systemThumb(page, `${name}.png`)).toHaveCount(0);

        await thumbAction(systemThumb(page, `${name}-renamed.png`), 'delete');
        await dialog(page).locator('.popup-button-ok').click();
        await expect(systemThumb(page, `${name}-renamed.png`)).toHaveCount(0);
        await expect(page.locator('#bg_menu_content .bg_example.selected-background')).toHaveCount(1);
    });

    test('a folder holds the backgrounds put in it', async ({ page }) => {
        await openDrawer(page);
        const folder = `E2E folder ${Date.now()}`;
        await page.locator('#bg_add_folder_button').click();
        await dialog(page).locator('.popup-input').fill(folder);
        await dialog(page).locator('.popup-button-ok').click();
        const tile = page.locator('.bg_folder_tile', { hasText: folder });
        await expect(tile).toBeVisible();

        const file = await anotherBackground(page);
        await thumbAction(systemThumb(page, file), 'folder');
        await dialog(page).locator('label', { hasText: folder }).locator('input').check();
        await dialog(page).locator('.popup-button-ok').click();

        await tile.click();
        await expect(page.locator('#bg_current_folder_name')).toHaveText(folder);
        await expect(page.locator('#bg_menu_content .bg_example')).toHaveCount(1);
        await expect(systemThumb(page, file)).toBeVisible();
        await page.locator('#bg_back_to_folders').click();
        await expect(page.locator('#bg_menu_content .bg_example').nth(1)).toBeVisible();
    });

    test('the fitting is the server\'s, and upstream\'s module reads it', async ({ page }) => {
        await openDrawer(page);
        const current = await page.locator('#background_fitting').inputValue();
        const next = current === 'cover' ? 'contain' : 'cover';
        await page.locator('#background_fitting').selectOption(next);
        await expect(page.locator('#bg1')).toHaveClass(new RegExp(`\\b${next}\\b`));
        await expect.poll(() => page.evaluate(async () => (await import('/scripts/backgrounds.js')).background_settings.fitting)).toBe(next);
        await page.reload();
        await testSetup.awaitST({ page });
        await expect(page.locator('#bg1')).toHaveClass(new RegExp(`\\b${next}\\b`));
    });
});
