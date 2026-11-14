import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greetings });
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
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
function shownText(page) {
    return page.evaluate(() => {
        // @ts-ignore
        return stTest.context().chat[0]?.mes;
    });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('the greeting a card shows', () => {
    test.beforeEach(testSetup.awaitST);

    test('is the last one paged to, however quickly the pager moves, after a reload too', async ({ page }) => {
        test.setTimeout(90000);
        const s = stamp();
        const g = Array.from({ length: 7 }, (_, i) => `Greeting ${i} ${s}`);
        const avatar = await createCharacter(page, `Pager-${s}`, g);
        await openCharacter(page, avatar);
        await openInfoTab(page, 'greeting');
        const input = page.locator('.greeting-pager-input');
        // A network that takes a different time for each request, as a real one does
        await page.route('**/api/characters/greetings/show', async (route) => {
            await new Promise(resolve => setTimeout(resolve, Math.random() * 200));
            await route.continue();
        });
        for (const moves of [9, 4, 12]) {
            const before = Number(await input.inputValue());
            for (let i = 0; i < moves; i++) await page.evaluate(() => {
                // @ts-ignore
                $('.greeting-pager-next').trigger('click');
            });
            const expected = String(((before - 1 + moves) % g.length) + 1);
            await expect(input).toHaveValue(expected);
            await page.waitForTimeout(500);
            await page.reload();
            await testSetup.awaitST({ page });
            await openCharacter(page, avatar);
            await openInfoTab(page, 'greeting');
            await expect(input).toHaveValue(expected);
        }
    });
});
