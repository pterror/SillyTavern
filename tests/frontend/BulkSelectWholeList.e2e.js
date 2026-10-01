import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Bulk edit selects over the whole list, not the drawn page: "select all" means every character the list's filter
// and search match, a shift-click range spans pages, the selection carries over to other pages and is cleared by
// another search, and each action is one server action over the selection. Bulk convert to persona asks only when a
// persona already exists, about that character, with a choice for all of them.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} prefix
 * @param {number} n
 * @returns {Promise<string[]>} the avatars, in name order
 */
async function createCharacters(page, prefix, n) {
    return page.evaluate(async ({ prefix, n }) => {
        const { getRequestHeaders } = await import('./script.js');
        const avatars = [];
        for (let i = 0; i < n; i++) {
            const form = new FormData();
            form.set('ch_name', `${prefix} ${String(i).padStart(2, '0')}`);
            const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            avatars.push(await response.text());
        }
        return avatars;
    }, { prefix, n });
}

/**
 * Shows only these characters (a tag only they carry, as the list's tag filter), five rows a page, in bulk edit mode.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
async function showInBulkMode(page, avatars) {
    await page.evaluate(async (avatars) => {
        const { getRequestHeaders } = await import('./script.js');
        const tagId = `bulk-${Date.now()}-${Math.random()}`;
        const post = (url, body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        await post('/api/tags/create', { tag: { id: tagId, name: tagId, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
        for (const avatar of avatars) await post('/api/tags/assign', { id: avatar, tagId });
        const { accountStorage } = await import('./scripts/util/AccountStorage.js');
        accountStorage.setItem('Characters_PerPage', '5');
        const { entitiesFilter } = await import('./scripts/character-list.js');
        const { FILTER_TYPES } = await import('./scripts/filters.js');
        entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [tagId], excluded: [] });
    }, avatars);
    await openCharacterManagementDrawer(page);
    await expect.poll(() => page.evaluate(async () => {
        const { getCharacterListPageContext } = await import('./scripts/character-list.js');
        return getCharacterListPageContext().total;
    }), { timeout: 30000 }).toBe(avatars.length);
    await expect(page.locator('#rm_print_characters_block .character_select')).toHaveCount(Math.min(5, avatars.length));
    await page.locator('#bulkEditButton').click();
    await expect(page.locator('#bulkSelectAllButton')).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
const selectedRows = page => page.locator('#rm_print_characters_block .character_select.character_selected');

/** @param {import('@playwright/test').Page} page @param {string[]} avatars @returns {Promise<Record<string, boolean>>} */
async function existing(page, avatars) {
    return page.evaluate(async (avatars) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/exists', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ids: avatars }) });
        return response.json();
    }, avatars);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function storedFav(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        const character = await response.json();
        return character.fav === true || character.fav === 'true';
    }, avatar);
}

test.describe('bulk edit over the whole list', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
    });

    test('select all takes every page, carries over to the next page, and delete counts them exactly first', async ({ page }) => {
        const stamp = `BulkAll${Date.now()}`;
        const avatars = await createCharacters(page, stamp, 12);
        await showInBulkMode(page, avatars);

        await page.locator('#bulkSelectAllButton').click();
        await expect(page.locator('#bulkSelectedCount')).toHaveText('~12');
        await expect(selectedRows(page)).toHaveCount(5);

        await page.locator('#rm_print_characters_pagination .J-paginationjs-next').first().click();
        await expect(selectedRows(page)).toHaveCount(5);

        await page.locator('#bulkDeleteButton').click();
        await expect(page.locator('dialog[open] h3', { hasText: 'Delete 12 characters?' })).toBeVisible();
        await page.locator('dialog[open] .popup-button-ok').click();

        await expect.poll(async () => Object.values(await existing(page, avatars)).filter(Boolean).length, { timeout: 20000 }).toBe(0);
    });

    test('a shift-click range reaches across pages, and only that range is favorited', async ({ page }) => {
        const stamp = `BulkRange${Date.now()}`;
        const avatars = await createCharacters(page, stamp, 12);
        await showInBulkMode(page, avatars);

        const positions = await page.locator('#rm_print_characters_block .character_select').evaluateAll(rows => rows.map(row => [row.getAttribute('data-avatar'), Number(row.getAttribute('data-list-position'))]));
        const start = positions[1];
        await page.locator(`#rm_print_characters_block .character_select[data-avatar="${start[0]}"]`).click();
        const firstRow = page.locator('#rm_print_characters_block .character_select').first();
        await page.locator('#rm_print_characters_pagination .J-paginationjs-next').first().click();
        await expect(firstRow).toHaveAttribute('data-list-position', '5');
        await page.locator('#rm_print_characters_pagination .J-paginationjs-next').first().click();
        await expect(firstRow).toHaveAttribute('data-list-position', '10');
        const lastPage = await page.locator('#rm_print_characters_block .character_select').evaluateAll(rows => rows.map(row => [row.getAttribute('data-avatar'), Number(row.getAttribute('data-list-position'))]));
        const end = lastPage.find(([, position]) => position === 10);
        await page.locator(`#rm_print_characters_block .character_select[data-avatar="${end[0]}"]`).click({ modifiers: ['Shift'] });
        await expect(page.locator('#bulkSelectedCount')).toHaveText('~10');

        // The list's own order decides the range, so read which characters sit at positions 1..10 from it.
        const inRange = await page.evaluate(async () => {
            const { characterRepository } = await import('./scripts/character-repository.js');
            const { getCharacterListPageContext } = await import('./scripts/character-list.js');
            const { query } = getCharacterListPageContext();
            const result = await characterRepository.query(query.filter, query.sort, 1, 100, ['rows']);
            return result.rows.slice(1, 11).map(row => (row.item ?? row).avatar);
        });

        await page.evaluate(async () => {
            const { characterGroupOverlay } = await import('./script.js');
            await characterGroupOverlay.handleContextMenuFavorite();
        });

        await expect.poll(async () => {
            const favs = await Promise.all(avatars.map(avatar => storedFav(page, avatar)));
            return avatars.filter((_, i) => favs[i]).sort();
        }, { timeout: 20000 }).toEqual([...inRange].sort());
    });

    test('another search clears the selection', async ({ page }) => {
        const stamp = `BulkClear${Date.now()}`;
        const avatars = await createCharacters(page, stamp, 6);
        await showInBulkMode(page, avatars);

        await page.locator('#bulkSelectAllButton').click();
        await expect(page.locator('#bulkSelectedCount')).toHaveText('~6');
        if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
        await page.locator('#character_search_bar').fill(`${stamp} 0`);
        await expect(page.locator('#bulkSelectedCount')).toHaveText('0');
        await expect(selectedRows(page)).toHaveCount(0);
    });

    test('convert to persona asks only about a persona that exists, and "Overwrite all" settles every later one', async ({ page }) => {
        const stamp = `BulkPersona${Date.now()}`;
        const avatars = await createCharacters(page, stamp, 5);
        await showInBulkMode(page, avatars);
        // Two of them are personas already, with a description that must be overwritten.
        await page.evaluate(async (stamp) => {
            const { personaStore } = await import('./scripts/power-user.js');
            for (const i of ['01', '03']) {
                personaStore.create(`${stamp} ${i} (Persona).png`, { name: `${stamp} ${i}`, description: 'old', position: 0, depth: 2, role: 0, lorebook: '', title: '', connections: [] });
            }
        }, stamp);

        await page.locator('#bulkSelectAllButton').click();
        const converting = page.evaluate(async () => {
            const { characterGroupOverlay } = await import('./script.js');
            await characterGroupOverlay.handleContextMenuPersona();
        });

        const ask = page.locator('dialog[open]', { hasText: 'already exists as a persona' });
        await expect(ask).toBeVisible();
        await ask.getByText('Overwrite all', { exact: true }).click();
        await converting;

        const stored = await page.evaluate(async (stamp) => {
            const { personaStore } = await import('./scripts/power-user.js');
            return ['00', '01', '02', '03', '04'].map(i => personaStore.has(`${stamp} ${i} (Persona).png`) && personaStore.get(`${stamp} ${i} (Persona).png`).description !== 'old');
        }, stamp);
        expect(stored).toEqual([true, true, true, true, true]);
        await expect(page.locator('dialog[open]', { hasText: 'already exists as a persona' })).toHaveCount(0);
    });

    test('convert to persona: "Skip" leaves that persona as it was and converts the rest, asking nothing else', async ({ page }) => {
        const stamp = `BulkSkip${Date.now()}`;
        const avatars = await createCharacters(page, stamp, 3);
        await showInBulkMode(page, avatars);
        await page.evaluate(async (stamp) => {
            const { personaStore } = await import('./scripts/power-user.js');
            personaStore.create(`${stamp} 01 (Persona).png`, { name: `${stamp} 01`, description: 'old', position: 0, depth: 2, role: 0, lorebook: '', title: '', connections: [] });
        }, stamp);

        await page.locator('#bulkSelectAllButton').click();
        const converting = page.evaluate(async () => {
            const { characterGroupOverlay } = await import('./script.js');
            await characterGroupOverlay.handleContextMenuPersona();
        });
        const ask = page.locator('dialog[open]', { hasText: `${stamp} 01 already exists as a persona` });
        await expect(ask).toBeVisible();
        await ask.getByText('Skip', { exact: true }).click();
        await converting;

        const descriptions = await page.evaluate(async (stamp) => {
            const { personaStore } = await import('./scripts/power-user.js');
            return ['00', '01', '02'].map(i => personaStore.get(`${stamp} ${i} (Persona).png`)?.description ?? null);
        }, stamp);
        expect(descriptions[1]).toBe('old');
        expect(descriptions[0]).not.toBeNull();
        expect(descriptions[2]).not.toBeNull();
    });
});
