import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}
if (process.env.PLAYWRIGHT_BASIC_AUTH_USER) {
    test.use({
        httpCredentials: {
            username: process.env.PLAYWRIGHT_BASIC_AUTH_USER,
            password: process.env.PLAYWRIGHT_BASIC_AUTH_PASS ?? '',
        },
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<'warning'|'active'|'other'>}
 */
async function globeColor(page) {
    return await page.evaluate(() => {
        const resolve = (variable) => {
            const probe = document.createElement('span');
            probe.style.color = `var(${variable})`;
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        };
        const globe = getComputedStyle(/** @type {Element} */ (document.getElementById('world_button'))).color;
        return globe === resolve('--warning') ? 'warning' : globe === resolve('--active') ? 'active' : 'other';
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function deleteBookFile(page, name) {
    await page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
    }, name);
}

test.describe('a link to a lorebook that doesn\'t exist', () => {
    test.beforeEach(testSetup.awaitST);

    test('shows on the globe, and follows the link, the books and the embedded book', async ({ page }) => {
        const missingName = `Missing Book ${Date.now()}`;
        const otherMissingName = `Other Missing Book ${Date.now()}`;

        const avatar = await page.evaluate(async (missingName) => {
            const { getRequestHeaders } = await import('./script.js');
            const card = {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: { name: 'Lost Link', extensions: { world: missingName } },
            };
            const form = new FormData();
            form.set('ch_name', 'Lost Link');
            form.set('world', missingName);
            form.set('fav', 'false');
            form.set('json_data', JSON.stringify(card));
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: form,
            });
            if (!response.ok) {
                throw new Error(`create failed: ${response.status}`);
            }
            return await response.text();
        }, missingName);

        try {
            await testSetup.awaitST({ page });
            const globe = page.locator('#world_button');
            const ownTitle = await globe.getAttribute('title');
            expect(ownTitle).toContain('Character Lore');

            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('./script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await openCharacterManagementDrawer(page);
            await expect(globe).toBeVisible();

            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);
            await expect.poll(() => globeColor(page)).toBe('warning');
            await expect(page.locator('#toast-container .toast', { hasText: missingName })).toHaveCount(0);

            await page.evaluate(async (missingName) => {
                const { createNewWorldInfo } = await import('./scripts/world-info.js');
                await createNewWorldInfo(missingName);
            }, missingName);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));
            await expect.poll(() => globeColor(page)).toBe('active');

            await page.evaluate(async (missingName) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(missingName);
            }, missingName);
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));

            await page.evaluate(async (missingName) => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld(missingName);
            }, missingName);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);

            await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('./script.js');
                const { getOneCharacter } = await import('./scripts/character-list.js');
                const response = await fetch('/api/characters/merge-attributes', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        avatar,
                        data: {
                            character_book: {
                                name: 'Inner Book',
                                extensions: {},
                                entries: [{ id: 0, keys: ['compass'], content: 'The compass points north.', enabled: true, insertion_order: 0, extensions: {} }],
                            },
                        },
                    }),
                });
                if (!response.ok) {
                    throw new Error(`merge failed: ${response.status}`);
                }
                await getOneCharacter(avatar);
            }, avatar);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));

            await page.evaluate(async (avatar) => {
                const { openEmbeddedLoreEditor } = await import('./scripts/world-info.js');
                await openEmbeddedLoreEditor(avatar);
            }, avatar);
            await page.locator('#world_popup_delete').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);

            await page.evaluate(async () => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld('');
            });
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));

            await page.evaluate(async (otherMissingName) => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld(otherMissingName);
            }, otherMissingName);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${otherMissingName}" not found`);

            await testSetup.awaitST({ page });
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('./script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${otherMissingName}" not found`);
        } finally {
            await deleteBookFile(page, missingName);
            await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('./script.js');
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
                });
            }, avatar);
        }
    });

    test('is shown set in the Link to World Info popup, and choosing "None" there clears it', async ({ page }) => {
        const missingName = `Popup Missing Book ${Date.now()}`;

        const avatar = await page.evaluate(async (missingName) => {
            const { getRequestHeaders } = await import('./script.js');
            const card = {
                spec: 'chara_card_v2',
                spec_version: '2.0',
                data: { name: 'Popup Lost Link', extensions: { world: missingName } },
            };
            const form = new FormData();
            form.set('ch_name', 'Popup Lost Link');
            form.set('world', missingName);
            form.set('fav', 'false');
            form.set('json_data', JSON.stringify(card));
            const response = await fetch('/api/characters/create', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
                body: form,
            });
            if (!response.ok) {
                throw new Error(`create failed: ${response.status}`);
            }
            return await response.text();
        }, missingName);

        const savedLink = () => page.evaluate(async (avatar) => {
            const { getRequestHeaders } = await import('./script.js');
            const response = await fetch('/api/characters/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar }),
            });
            const character = await response.json();
            return character?.data?.extensions?.world;
        }, avatar);

        try {
            await testSetup.awaitST({ page });
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('./script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            const globe = page.locator('#world_button');
            await expect(globe).toBeVisible();
            await expect(globe).toHaveClass(/\bwarning\b/);

            const select = page.locator('dialog[open] .character_world_info_selector');
            await globe.click({ modifiers: ['Shift'] });
            await expect(select.locator('option:checked')).toHaveText(`${missingName} (not found)`);

            await expect(page.locator('dialog[open]:not([opening]) .character_world_info_selector')).toHaveCount(1);
            await select.selectOption('');
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect.poll(savedLink).toBe('');
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(select).toHaveCount(0);

            await globe.click({ modifiers: ['Shift'] });
            await expect(select.locator('option:checked')).toHaveText('--- None ---');
            await expect(select.locator('option', { hasText: missingName })).toHaveCount(0);
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(select).toHaveCount(0);
        } finally {
            await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('./script.js');
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
                });
            }, avatar);
        }
    });

    test('shows on the globe in create mode, for the link the new character will be created with', async ({ page }) => {
        const bookName = `Create Mode Book ${Date.now()}`;
        const globe = page.locator('#world_button');
        const ownTitle = await globe.getAttribute('title');

        try {
            await openCharacterManagementDrawer(page);
            await page.locator('#rm_button_create').click();
            await expect(globe).toBeVisible();
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);

            await page.evaluate(async (bookName) => {
                const { createNewWorldInfo, charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await createNewWorldInfo(bookName);
                await charUpdatePrimaryWorld(bookName);
            }, bookName);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);

            const linkAfterDelete = await page.evaluate(async (bookName) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                const { create_save } = await import('./script.js');
                await deleteWorldInfo(bookName);
                return create_save.world;
            }, bookName);
            expect(linkAfterDelete).toBe('');
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);

            await page.evaluate(async (bookName) => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld(bookName);
            }, bookName);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${bookName}" not found`);

            await page.locator('#rm_button_back').click();
            await page.locator('#rm_button_create').click();
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${bookName}" not found`);

            await page.evaluate(async () => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld('');
            });
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));
        } finally {
            await deleteBookFile(page, bookName);
            await page.evaluate(async () => {
                const { create_save } = await import('./script.js');
                create_save.world = '';
            });
        }
    });
});
