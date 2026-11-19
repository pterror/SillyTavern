import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['stTest'].context().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return response.json();
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['stTest'].context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} name
 * @param {'OPEN'|'CLOSED'} folderType
 * @param {number} [order]
 */
async function createFolder(page, id, name, folderType, order = -Date.now()) {
    await api(page, '/api/tags/create', {
        tag: { id, name, folder_type: folderType, sort_order: order, is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} term
 */
async function setSearchTerm(page, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
}

/** @param {import('@playwright/test').Page} page */
const entries = page => page.locator('#rm_print_characters_block > *');
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
const row = (page, avatar) => page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id a closed folder's tag id, or "none" for the way back
 */
const folderEntry = (page, id) => page.locator(`#rm_print_characters_block .bogus_folder_select[data-folder-case="${id}"]`);

test.describe('folders', () => {
    test.setTimeout(120000);
    /** @type {string[]} */
    let made = [];

    test.beforeEach(async ({ page }) => {
        made = [];
        await loadApp(page);
        await openCharacterManagementDrawer(page);
    });

    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.evaluate(async () => {
            const { setCharacterView } = await import('/scripts/character-list.js');
            setCharacterView({ folderCase: 'none' });
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            accountStorage.removeItem('Characters_PerPage');
        }).catch(() => {});
        await setSearchTerm(page, '').catch(() => {});
        for (const id of made) await api(page, '/api/tags/delete', { id });
    });

    test('there is no "Tags as folders" setting, no "Show only folders" pill, and no folder switcher', async ({ page }) => {
        await expect(page.locator('#bogus_folders')).toHaveCount(0);
        expect(await page.evaluate(() => Object.hasOwn(window['stTest'].context().powerUserSettings, 'bogus_folders'))).toBe(false);
        await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.filterByFavorites')).toHaveCount(1);
        await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.filterByFolder')).toHaveCount(0);
        await expect(page.locator('#character_folder_switcher')).toHaveCount(0);
    });

    test('a saved "Show only folders" state is dropped on load', async ({ page }) => {
        await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            accountStorage.setItem('CharacterList_TagFilterState_FOLDER', 'SELECTED');
        });
        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        expect(await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            return accountStorage.getItem('CharacterList_TagFilterState_FOLDER');
        })).toBeNull();
    });

    test('a closed folder is the list\'s first entry, drawn as the list draws one: its name, a count and a folder icon', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Vault${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Vault${stamp} Inside`);
        const outside = await createCharacter(page, `Vault${stamp} Outside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });

        await setSearchTerm(page, `Vault${stamp}`);
        const entry = folderEntry(page, folderId);
        await expect(entry).toBeVisible();
        await expect(entries(page).first()).toHaveAttribute('data-folder-case', folderId);
        await expect(entry.locator('.ch_name')).toHaveText(`Vault${stamp}`);
        await expect(entry.locator('.bogus_folder_counter')).toHaveText('1');
        await expect(entry.locator('.bogus_folder_icon.fa-folder-closed')).toBeVisible();
        await expect(entry).toHaveAttribute('role', 'listitem');
        await expect(entry).toHaveAttribute('aria-label', `Folder Vault${stamp}, 1 characters and groups`);
        await expect(row(page, outside)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
    });

    test('opening a folder shows what it holds after the way back; going back shows the rest, and the case survives a reload', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-open-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Crate${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Crate${stamp} Inside`);
        const outside = await createCharacter(page, `Crate${stamp} Outside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, `Crate${stamp}`);

        await folderEntry(page, folderId).click();
        await expect(row(page, inside)).toBeVisible();
        await expect(row(page, outside)).toHaveCount(0);
        await expect(entries(page).first()).toHaveAttribute('data-folder-case', 'none');
        await expect(folderEntry(page, 'none')).toHaveAttribute('aria-label', 'Go back');
        await expect(folderEntry(page, folderId)).toHaveCount(0);

        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await setSearchTerm(page, `Crate${stamp}`);
        await expect(row(page, inside)).toBeVisible();
        await expect(folderEntry(page, 'none')).toBeVisible();

        await folderEntry(page, 'none').click();
        await expect(row(page, outside)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
        await expect(folderEntry(page, folderId)).toBeVisible();
    });

    test('Back preserves typed search text and cannot be undone by a queued search edit', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-pending-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Pending${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Pending${stamp} Inside`);
        const outside = await createCharacter(page, `Pending${stamp} Outside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, `Pending${stamp}`);
        await folderEntry(page, folderId).click();
        await expect(row(page, inside)).toBeVisible();
        await page.clock.install();
        await page.evaluate(term => {
            const field = document.querySelector('#character_search_bar');
            field.value = term;
            field.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#rm_print_characters_block [data-folder-case="none"]').click();
        }, `Pending${stamp} Outside`);
        await page.clock.runFor(1000);
        await expect(row(page, outside)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
        await expect(page.locator('#character_search_bar')).toHaveValue(`Pending${stamp} Outside`);
        expect(await page.evaluate(async () => (await import('/scripts/character-list.js')).getCharacterView().folderCase)).toBe('none');
    });

    test('the keyboard opens a folder and goes back, as it opens any entry', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-keys-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Locker${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Locker${stamp} Inside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, `Locker${stamp}`);

        const entry = folderEntry(page, folderId);
        await expect(entry).toHaveAttribute('tabindex', '0');
        await entry.focus();
        await page.keyboard.press('Enter');
        await expect(row(page, inside)).toBeVisible();

        const back = folderEntry(page, 'none');
        await expect(back).toHaveAttribute('tabindex', '0');
        await back.focus();
        await page.keyboard.press('Enter');
        await expect(row(page, inside)).toHaveCount(0);
        await expect(folderEntry(page, folderId)).toBeVisible();
    });

    test('a search lists the folders whose name holds its words, and no folder for a search of another field', async ({ page }) => {
        const stamp = Date.now();
        const hit = `closed-hit-${stamp}`;
        const miss = `closed-miss-${stamp}`;
        made.push(hit, miss);
        await createFolder(page, hit, `Attic${stamp} Boxes`, 'CLOSED');
        await createFolder(page, miss, `Cellar${stamp}`, 'CLOSED');

        await setSearchTerm(page, `boxes attic${stamp}`);
        await expect(folderEntry(page, hit)).toBeVisible();
        await expect(folderEntry(page, miss)).toHaveCount(0);

        await setSearchTerm(page, `creator:Attic${stamp}`);
        await expect(page.locator('#rm_print_characters_block .bogus_folder_select')).toHaveCount(0);
    });

    test('a tag made a closed folder becomes an entry; a folder no longer closed while shown sends the list back to the rest', async ({ page }) => {
        const stamp = Date.now();
        const tagId = `made-closed-${stamp}`;
        made.push(tagId);
        await createFolder(page, tagId, `Later${stamp}`, 'OPEN');
        const inside = await createCharacter(page, `Later${stamp}`);
        await api(page, '/api/tags/assign', { id: inside, tagId });
        await setSearchTerm(page, `Later${stamp}`);
        await expect(row(page, inside)).toBeVisible();
        await expect(folderEntry(page, tagId)).toHaveCount(0);

        await api(page, '/api/tags/edit', { id: tagId, patch: { folder_type: 'CLOSED' } });
        await expect(folderEntry(page, tagId)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);

        await folderEntry(page, tagId).click();
        await expect(row(page, inside)).toBeVisible();
        await api(page, '/api/tags/edit', { id: tagId, patch: { folder_type: 'OPEN' } });
        await expect(folderEntry(page, 'none')).toHaveCount(0);
        await expect(row(page, inside)).toBeVisible();
        expect(await page.evaluate(async () => (await import('/scripts/character-list.js')).getCharacterView().folderCase)).toBe('none');
    });

    test('a character in two closed folders shows under both', async ({ page }) => {
        const stamp = Date.now();
        const a = `closed-a-${stamp}`;
        const b = `closed-b-${stamp}`;
        made.push(a, b);
        await createFolder(page, a, `Twice${stamp} A`, 'CLOSED');
        await createFolder(page, b, `Twice${stamp} B`, 'CLOSED');
        const both = await createCharacter(page, `Twice${stamp}`);
        await api(page, '/api/tags/assign', { id: both, tagId: a });
        await api(page, '/api/tags/assign', { id: both, tagId: b });
        await setSearchTerm(page, `Twice${stamp}`);

        await expect(row(page, both)).toHaveCount(0);
        await folderEntry(page, a).click();
        await expect(row(page, both)).toBeVisible();
        await folderEntry(page, 'none').click();
        await folderEntry(page, b).click();
        await expect(row(page, both)).toBeVisible();
    });

    test('upstream\'s chooseBogusFolder() picks a closed folder\'s case', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-up-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Crypt${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Crypt${stamp}`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, `Crypt${stamp}`);
        await expect(folderEntry(page, folderId)).toBeVisible();

        await page.evaluate(async id => (await import('/scripts/tags.js')).chooseBogusFolder(null, id), folderId);
        await expect(row(page, inside)).toBeVisible();
        expect(await page.evaluate(async () => (await import('/scripts/tags.js')).isBogusFolderOpen())).toBe(true);

        await page.evaluate(async id => (await import('/scripts/tags.js')).chooseBogusFolder(null, id, true), folderId);
        await expect(folderEntry(page, folderId)).toBeVisible();
    });

    test('many folders are paged as the list\'s first rows, and the total counts them', async ({ page }) => {
        const stamp = Date.now();
        const ids = Array.from({ length: 23 }, (_, i) => `closed-many-${stamp}-${i}`);
        made.push(...ids);
        for (const [i, id] of ids.entries()) await createFolder(page, id, `Shelf${stamp} ${String(i).padStart(2, '0')}`, 'CLOSED', -1e12 + i);
        const loose = await createCharacter(page, `Shelf${stamp} Loose`);
        await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            accountStorage.setItem('Characters_PerPage', '10');
        });
        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await setSearchTerm(page, `Shelf${stamp}`);

        const nav = page.locator('#rm_print_characters_pagination .J-paginationjs-nav').first();
        const next = page.locator('#rm_print_characters_pagination .J-paginationjs-next').first();
        await expect(nav).toHaveText('1-10 .. 24');
        await expect(page.locator('#rm_print_characters_block .bogus_folder_select')).toHaveCount(10);
        await expect(entries(page).first()).toHaveAttribute('data-folder-case', ids[0]);
        await next.click();
        await expect(nav).toHaveText('11-20 .. 24');
        await expect(entries(page).first()).toHaveAttribute('data-folder-case', ids[10]);
        await next.click();
        await expect(nav).toHaveText('21-24 .. 24');
        await expect(page.locator('#rm_print_characters_block .bogus_folder_select')).toHaveCount(3);
        await expect(entries(page).last()).toHaveAttribute('data-avatar', loose);
    });

    test('the tile layout draws folders and the way back as tiles of the list', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-tile-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Tile${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Tile${stamp} Inside`);
        await createCharacter(page, `Tile${stamp} Outside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        const setTiles = (/** @type {boolean} */ on) => page.evaluate(async (on) => {
            const { power_user } = await import('/scripts/power-user.js');
            const { saveSettingsDebounced } = await import('/script.js');
            for (const layout of ['charListGrid', 'charGalleryGrid']) {
                power_user[layout] = on;
                document.body.classList.toggle(layout, on);
            }
            saveSettingsDebounced('power_user.charListGrid', 'power_user.charGalleryGrid');
        }, on);
        await setTiles(true);
        try {
            await setSearchTerm(page, `Tile${stamp}`);
            const entry = folderEntry(page, folderId);
            await expect(entry).toBeVisible();
            const tile = await entry.boundingBox();
            const character = await page.locator('#rm_print_characters_block .character_select').first().boundingBox();
            expect(tile && character && Math.abs(tile.width - character.width) <= 2).toBe(true);
            await entry.click();
            await expect(folderEntry(page, 'none')).toBeVisible();
            await expect(row(page, inside)).toBeVisible();
        } finally {
            await setTiles(false);
        }
    });

    test('an open folder is a view in the picker\'s Folders section', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `open-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Shelf ${stamp}`, 'OPEN');
        const inside = await createCharacter(page, `OpenView${stamp} In`);
        const outside = await createCharacter(page, `OpenView${stamp} Out`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, '');

        await page.locator('#character_view_picker').click();
        const folderRow = page.locator(`.view_picker_popover .view_picker_folder[data-view-id="folder:${folderId}"]`);
        await expect(folderRow).toBeVisible();
        await folderRow.locator('.view_picker_row_name').click();
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText(`Shelf ${stamp}`);
        await setSearchTerm(page, `OpenView${stamp}`);
        await expect(row(page, inside)).toBeVisible();
        await expect(row(page, outside)).toHaveCount(0);

        await page.locator('#character_view_picker').click();
        await expect(page.locator('.view_picker_unsaved [data-action="save"]')).toHaveCount(0);
        await expect(page.locator('.view_picker_unsaved [data-action="save-as"]')).toBeVisible();
        await page.keyboard.press('Escape');
    });
});
