import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 * @param {number} perPage
 */
async function showOwnCharacters(page, n, perPage) {
    await page.evaluate(async ({ n, perPage }) => {
        const { getRequestHeaders } = await import('./script.js');
        const prefix = `PageTurn-${Date.now()}`;
        const tagId = `${prefix}-tag`;
        const post = (url, body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
        await post('/api/tags/create', { tag: { id: tagId, name: tagId, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
        for (let i = 0; i < n; i++) {
            const form = new FormData();
            form.append('ch_name', `${prefix}-${String(i).padStart(2, '0')}`);
            const headers = getRequestHeaders();
            delete headers['Content-Type'];
            const avatar = (await (await fetch('/api/characters/create', { method: 'POST', headers, body: form })).text()).trim();
            await post('/api/tags/assign', { id: avatar, tagId });
        }
        const { accountStorage } = await import('./scripts/util/AccountStorage.js');
        accountStorage.setItem('Characters_PerPage', String(perPage));
        const { entitiesFilter } = await import('./scripts/character-list.js');
        const { FILTER_TYPES } = await import('./scripts/filters.js');
        entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected: [tagId], excluded: [] });
    }, { n, perPage });
    await openCharacterManagementDrawer(page);
    await expect(page.locator('#rm_print_characters_block .character_select')).toHaveCount(perPage, { timeout: 30000 });
}

const list = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#rm_print_characters_block');
const scroll = (/** @type {import('@playwright/test').Page} */ page) => list(page).evaluate(el => ({ top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) }));
const scrollTo = (/** @type {import('@playwright/test').Page} */ page, /** @type {number | 'bottom'} */ to) => list(page).evaluate((el, to) => { el.scrollTop = to === 'bottom' ? el.scrollHeight : to; }, to);
const firstName = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#rm_print_characters_block .character_select .ch_name').first().textContent();

test('a page turned from the list\'s end starts at the other end; from the middle it keeps its place', async ({ page }) => {
    await testSetup.awaitST({ page });
    await showOwnCharacters(page, 60, 25);
    expect((await scroll(page)).max).toBeGreaterThan(100);

    await expect.poll(async () => {
        await scrollTo(page, 'bottom');
        const s = await scroll(page);
        return s.top === s.max;
    }).toBe(true);
    const before = await firstName(page);
    await page.locator('#rm_print_characters_pagination .paginationjs-next').click();
    await expect.poll(() => firstName(page)).not.toBe(before);
    await expect.poll(async () => (await scroll(page)).top).toBe(0);

    const second = await firstName(page);
    await page.locator('#rm_print_characters_pagination .paginationjs-prev').click();
    await expect.poll(() => firstName(page)).not.toBe(second);
    await expect.poll(async () => { const s = await scroll(page); return s.top === s.max; }).toBe(true);

    await scrollTo(page, 50);
    const first = await firstName(page);
    await page.locator('#rm_print_characters_pagination .paginationjs-next').click();
    await expect.poll(() => firstName(page)).not.toBe(first);
    await expect.poll(async () => (await scroll(page)).top).toBe(50);
});
