import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>} the avatar
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

test.describe('the number box of the greeting pager', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<string[]>}
     */
    async function open(page) {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const g = Array.from({ length: 4 }, (_, i) => `Greeting ${i} ${s}`);
        await openCharacter(page, await createCharacter(page, `Step-${s}`, g));
        await openInfoTab(page, 'greeting');
        return g;
    }

    test('switches greeting at once on the arrow keys, but not on typing until Enter', async ({ page }) => {
        const g = await open(page);
        const input = page.locator('.greeting-pager-input');
        let kept = 0;
        page.on('request', request => { if (request.url().endsWith('/api/characters/greetings/show')) kept++; });
        await input.focus();
        await page.keyboard.press('ArrowUp');
        await expect(input).toHaveValue('2');
        await expect.poll(() => kept).toBe(1);
        await expect(page.locator('#greeting_field')).toHaveValue(g[1]);
        await page.keyboard.press('ArrowUp');
        await expect(page.locator('#greeting_field')).toHaveValue(g[2]);
        await page.keyboard.press('ArrowDown');
        await expect(input).toHaveValue('2');
        await expect(page.locator('#greeting_field')).toHaveValue(g[1]);

        await page.keyboard.press('Control+A');
        await page.keyboard.type('4');
        await page.waitForTimeout(300);
        expect(kept).toBe(3);
        await expect(page.locator('#greeting_field')).toHaveValue(g[1]);
        await page.keyboard.press('Enter');
        await expect(page.locator('#greeting_field')).toHaveValue(g[3]);
    });

    test('does not go past the last greeting or before the first', async ({ page }) => {
        const g = await open(page);
        const input = page.locator('.greeting-pager-input');
        await input.focus();
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(300);
        await expect(input).toHaveValue('1');
        await expect(page.locator('#greeting_field')).toHaveValue(g[0]);
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
        await expect(input).toHaveValue('4');
        await expect(page.locator('#greeting_field')).toHaveValue(g[3]);
    });

    test('switches greeting on its spinner', async ({ page }) => {
        const g = await open(page);
        const input = page.locator('.greeting-pager-input');
        await input.hover();
        const box = /** @type {NonNullable<Awaited<ReturnType<typeof input.boundingBox>>>} */ (await input.boundingBox());
        await page.mouse.click(box.x + box.width - 5, box.y + box.height * 0.25);
        await expect(input).toHaveValue('2');
        await expect(page.locator('#greeting_field')).toHaveValue(g[1]);
    });

    test('refuses a step while a field is being edited and shows the greeting again', async ({ page }) => {
        const g = await open(page);
        const input = page.locator('.greeting-pager-input');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await input.evaluate((/** @type {HTMLInputElement} */ element) => {
            element.stepUp();
            element.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await expect(input).toHaveValue('1');
        await expect(page.locator('#greeting_field')).toHaveValue(g[0]);
    });
});
