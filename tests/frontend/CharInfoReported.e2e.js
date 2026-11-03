import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} greetings
 * @param {string} [name]
 * @returns {Promise<string>}
 */
async function createAndOpen(page, greetings, name = `CharInfo-${stamp()}`) {
    const avatar = await page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0] ?? '');
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return (await response.text()).trim();
    }, { name, greetings });
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
async function storedGreetings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        const card = await response.json();
        return [card.data.first_mes, ...(card.data.alternate_greetings ?? [])];
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function writeGreeting(page, text) {
    await expect(page.locator('#charInfoTab_greeting .cm-editor')).toBeVisible();
    await page.locator('#charInfoTab_greeting .cm-content').click();
    await page.keyboard.press('Control+A');
    if (text === '') await page.keyboard.press('Backspace');
    else await page.keyboard.type(text);
    await page.locator('.field_edit_done[data-for="greeting_field"]').click();
    await expect(page.locator('#charInfoTab_greeting .cm-editor')).toHaveCount(0);
}

test.describe('character info greeting pager', () => {
    test.beforeEach(testSetup.awaitST);

    test('CL6: editing a greeting keeps the pager on it', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one', 'two', 'three']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await page.locator('.greeting-pager-next').click();
        await expect(page.locator('.greeting-pager-input')).toHaveValue('3');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await writeGreeting(page, 'three edited');
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['one', 'two', 'three edited']);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(500);
        await expect(page.locator('.greeting-pager-input')).toHaveValue('3');
        await expect(page.locator('#greeting_field')).toHaveValue('three edited');
    });

    test('CL6: adding a greeting keeps the pager on it', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one', 'two']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-add').click();
        await expect(page.locator('.greeting-pager-input')).toHaveValue('3');
        await writeGreeting(page, 'added');
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['one', 'two', 'added']);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(500);
        await expect(page.locator('.greeting-pager-input')).toHaveValue('3');
        await expect(page.locator('.greeting-pager-total')).toHaveText('/3');
        await expect(page.locator('#greeting_field')).toHaveValue('added');
    });

    test('CL5: the pager deletes the greeting shown, after asking', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one', 'two', 'three']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await expect(page.locator('#greeting_field')).toHaveValue('two');

        await page.locator('.greeting-pager-delete').click();
        await page.locator('.popup .popup-button-cancel').last().click();
        await expect(page.locator('.greeting-pager-total')).toHaveText('/3');

        const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/greetings/delete');
        await page.locator('.greeting-pager-delete').click();
        await page.locator('.popup .popup-button-ok').last().click();
        expect((await deleted).ok()).toBe(true);
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['one', 'three']);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');
        await expect(page.locator('.greeting-pager-input')).toHaveValue('2');
        await expect(page.locator('#greeting_field')).toHaveValue('three');
    });

    test('GR1: a new greeting slot left blank leaves the list when its edit ends, cancelled or confirmed', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-add').click();
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');
        await page.locator('.field_edit_cancel[data-for="greeting_field"]').click();
        await expect(page.locator('.greeting-pager-total')).toHaveText('/1');
        await expect(page.locator('#greeting_field')).toHaveValue('one');

        await page.locator('.greeting-pager-add').click();
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect(page.locator('#charInfoTab_greeting')).not.toHaveClass(/field_editing/);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/1');
        await expect(page.locator('#greeting_field')).toHaveValue('one');
        expect(await storedGreetings(page, avatar)).toEqual(['one']);
    });

    test('GR2: the only greeting confirmed blank is removed, with no conflict', async ({ page }) => {
        const avatar = await createAndOpen(page, ['only']);
        await openInfoTab(page, 'greeting');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await writeGreeting(page, '');
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['']);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/1');
        await expect(page.locator('#greeting_field')).toHaveValue('');
        await expect(page.locator('#toast-container .toast', { hasText: 'not saved' })).toHaveCount(0);
    });

    test('GR3: a greeting among others confirmed blank is removed, with no conflict', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one', 'two', 'three']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await expect(page.locator('#greeting_field')).toHaveValue('two');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await writeGreeting(page, '');
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['one', 'three']);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');
        await expect(page.locator('#toast-container .toast', { hasText: 'not saved' })).toHaveCount(0);
    });

    test('GR3: a greeting emptied mid-edit is kept until the edit is confirmed', async ({ page }) => {
        const avatar = await createAndOpen(page, ['one', 'two']);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await expect(page.locator('#charInfoTab_greeting .cm-editor')).toBeVisible();
        await page.locator('#charInfoTab_greeting .cm-content').click();
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(1600);
        expect(await storedGreetings(page, avatar)).toEqual(['one', 'two']);
        await expect(page.locator('#toast-container .toast', { hasText: 'not saved' })).toHaveCount(0);
        await page.keyboard.type('two again');
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect.poll(() => storedGreetings(page, avatar)).toEqual(['one', 'two again']);
    });

    test('CL7: the pager input shows every digit', async ({ page }) => {
        await createAndOpen(page, Array.from({ length: 120 }, (_, i) => `g${i}`));
        await openInfoTab(page, 'greeting');
        const input = page.locator('.greeting-pager-input');
        await input.fill('118');
        await input.press('Enter');
        await expect(input).toHaveValue('118');
        const fits = await input.evaluate(element => element.scrollWidth <= element.clientWidth);
        expect(fits).toBe(true);
    });
});

test.describe('character list', () => {
    test.beforeEach(testSetup.awaitST);

    test('CL9: a favourite set in character info shows in the list once stored, without waiting for re-reads', async ({ page }) => {
        const avatar = await createAndOpen(page, ['hi']);
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().getCharacters();
        });
        const row = page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);
        await expect(row).toHaveCount(1, { timeout: 10000 });
        await expect(row).not.toHaveClass(/\bis_fav\b/);

        /** @type {() => void} */
        let release = () => {};
        const held = new Promise(resolve => { release = () => resolve(undefined); });
        await page.route(/\/api\/characters\/(get|query|batch|changes)$/, async (route) => {
            await held;
            await route.continue();
        });
        const stored = page.waitForResponse(response => response.url().endsWith('/api/characters/fav'));
        await page.locator('#favorite_button').click();
        expect((await stored).ok()).toBe(true);
        await expect(row).toHaveClass(/\bis_fav\b/, { timeout: 2000 });
        release();
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(500);
        await expect(row).toHaveClass(/\bis_fav\b/);
    });
});

test.describe('character info avatar', () => {
    test.beforeEach(testSetup.awaitST);

    test('CL8: a loaded avatar preview keeps its size', async ({ page }) => {
        await createAndOpen(page, ['hi']);
        const preview = page.locator('#avatar_load_preview');
        await preview.evaluate(element => new Promise((resolve, reject) => {
            const img = /** @type {HTMLImageElement} */ (element);
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', reject, { once: true });
            img.src = 'img/ai4.png';
        }));
        const size = await page.evaluate(() => {
            const style = getComputedStyle(document.body);
            return { width: parseFloat(style.getPropertyValue('--avatar-base-width')), height: parseFloat(style.getPropertyValue('--avatar-base-height')) };
        });
        const box = await preview.boundingBox();
        expect(box?.width).toBe(size.width);
        expect(box?.height).toBe(size.height);
    });
});

test.describe('character info field previews', () => {
    test.beforeEach(testSetup.awaitST);

    test('CL29: every field preview has the text look of a chat message', async ({ page }) => {
        await createAndOpen(page, ['First paragraph.\n\nSecond paragraph.']);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text p')).toHaveCount(2);
        const look = (/** @type {Element} */ el) => {
            const style = getComputedStyle(el);
            return { lineHeight: style.lineHeight, fontWeight: style.fontWeight, fontSize: style.fontSize };
        };
        const chat = await page.locator('#chat .mes[mesid="0"] .mes_text').evaluate(look);
        const previews = await page.locator('.field_preview').evaluateAll((els, chat) => els.map(el => {
            const style = getComputedStyle(el);
            return { for: el.getAttribute('data-for'), same: style.lineHeight === chat.lineHeight && style.fontWeight === chat.fontWeight && style.fontSize === chat.fontSize };
        }), chat);
        expect(previews.length).toBeGreaterThan(5);
        expect(previews.filter(p => !p.same)).toEqual([]);
    });
});
