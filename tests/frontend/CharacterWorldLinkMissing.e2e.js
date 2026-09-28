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
 * Which of the theme's colors the globe shows: its warning variable, the linked (`--active`) one, or another.
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

// A link (data.extensions.world) to a name with no World file, on a card with no embedded lorebook, points at
// nothing. The globe shows it once, where the link is: the warning color, and a tooltip naming the book. It
// follows the link, the World files and the embedded book as they change, and gets its own tooltip back as soon
// as the link points at something again, or at nothing.
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

            // Opening the character: the globe is in the warning color and names the book. No toast about it.
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);
            // Polled: .menu_button eases its color in.
            await expect.poll(() => globeColor(page)).toBe('warning');
            await expect(page.locator('#toast-container .toast', { hasText: missingName })).toHaveCount(0);

            // A book with that name is created: linked, with the globe's own tooltip.
            await page.evaluate(async (missingName) => {
                const { createNewWorldInfo } = await import('./scripts/world-info.js');
                await createNewWorldInfo(missingName);
            }, missingName);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));
            await expect.poll(() => globeColor(page)).toBe('active');

            // The book is deleted somewhere else, and the list of books is read again: missing again.
            await deleteBookFile(page, missingName);
            await page.evaluate(async () => {
                const { updateWorldInfoList } = await import('./scripts/world-info.js');
                await updateWorldInfoList();
            });
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);

            // The card gets an embedded lorebook (saved from elsewhere, then read again): the link is to that book.
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

            // The embedded lorebook is removed in the World Info editor: missing again.
            await page.evaluate(async (avatar) => {
                const { openEmbeddedLoreEditor } = await import('./scripts/world-info.js');
                await openEmbeddedLoreEditor(avatar);
            }, avatar);
            await page.locator('#world_popup_delete').click();
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${missingName}" not found`);

            // The link is cleared: not linked, with the globe's own tooltip.
            await page.evaluate(async () => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld('');
            });
            await expect(globe).not.toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', /** @type {string} */ (ownTitle));

            // The link is set to another name with no book: the tooltip names that one.
            await page.evaluate(async (otherMissingName) => {
                const { charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await charUpdatePrimaryWorld(otherMissingName);
            }, otherMissingName);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${otherMissingName}" not found`);

            // Opened again after a reload: still shown.
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

            // Linking an existing book in create mode shows it linked.
            await page.evaluate(async (bookName) => {
                const { createNewWorldInfo, charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                await createNewWorldInfo(bookName);
                await charUpdatePrimaryWorld(bookName);
            }, bookName);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);

            // Deleting that book leaves the new character's link naming it: missing.
            const linkAfterDelete = await page.evaluate(async (bookName) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                const { create_save } = await import('./script.js');
                await deleteWorldInfo(bookName);
                return create_save.world;
            }, bookName);
            expect(linkAfterDelete).toBe(bookName);
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).not.toHaveClass(/\bworld_set\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${bookName}" not found`);

            // Leaving create mode for the character list and coming back: still shown.
            await page.locator('#rm_button_back').click();
            await page.locator('#rm_button_create').click();
            await expect(globe).toHaveClass(/\bwarning\b/);
            await expect(globe).toHaveAttribute('title', `Linked lorebook "${bookName}" not found`);

            // Clearing the link in create mode: not linked, with the globe's own tooltip.
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
