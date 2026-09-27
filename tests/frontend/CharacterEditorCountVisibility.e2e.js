import { test, expect } from './fixtures.js';
import { openInfoTab, testSetup } from './frontent-test-utils.js';

// NixOS host: the Playwright-managed Chromium download is missing system libs, so fall back
// to the system-provided Chrome (only when explicitly pointed at it) rather than requiring a
// FHS-compatible browser install.
if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Character editor token counts are requested only while the editor is showing: #char-info-panel open,
// not covered, with the editor as its menu. Internal triggers that fire while it is hidden wait for it to
// show. The exported forceCharacterEditorTokenize() still counts right away, as upstream's does.

// Longer than the editor's 1000 ms count debounce, so a count that is going to be sent has been sent.
const QUIET_MS = 2500;

/**
 * Makes the page record, at send time, every tokenizer request and whether the editor was showing then.
 * Runs before the app's scripts on every load.
 * @param {import('@playwright/test').Page} page
 */
async function recordTokenizerSends(page) {
    await page.addInitScript(() => {
        const sends = [];
        window['__tokenizerSends'] = sends;
        const editorShowing = () => {
            const panel = document.getElementById('char-info-panel');
            return Boolean(panel?.classList.contains('openDrawer'))
                && getComputedStyle(panel).visibility !== 'hidden'
                && panel.getAttribute('data-active-menu') === 'rm_ch_create_block';
        };
        const record = (url, body) => {
            if (String(url).includes('/api/tokenizers/')) {
                sends.push({ url: String(url), body: typeof body === 'string' ? body : '', showing: editorShowing() });
            }
        };
        const open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this['__url'] = url;
            return open.call(this, method, url, ...rest);
        };
        const send = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
            record(this['__url'], body);
            return send.call(this, body);
        };
        const fetch = window.fetch;
        window.fetch = function (input, init) {
            record(input instanceof Request ? input.url : input, init?.body);
            return fetch.call(this, input, init);
        };
    });
}

/**
 * The recorded tokenizer requests that count the marker.
 * @param {import('@playwright/test').Page} page
 * @param {string} marker
 * @returns {Promise<{ url: string, showing: boolean }[]>}
 */
async function countsOf(page, marker) {
    return await page.evaluate(m => window['__tokenizerSends'].filter(s => s.body.includes(m)).map(({ url, showing }) => ({ url, showing })), marker);
}

/**
 * Creates and selects a character whose description holds a fresh marker, then closes every drawer.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ name: string, marker: string }>}
 */
async function createCharacterAndCloseEditor(page) {
    const marker = `count-visibility-marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const name = `CountVisibility-${Date.now()}`;
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').evaluate(el => el.click());
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
    await openInfoTab(page, 'description');
    await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
    await page.locator('#description_textarea').fill(`A test character. ${marker}`);
    await page.locator('.field_edit_done[data-for="description_textarea"]').click();
    // A click on the chat closes every unpinned drawer.
    await page.locator('#chat').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#char-info-panel')).toBeHidden();
    await expect(page.locator('#right-nav-panel')).toBeHidden();
    await page.waitForTimeout(QUIET_MS);
    return { name, marker };
}

// With no connection, best match (the default) counts with Llama, so on a fresh page nothing is cached for GPT-2.
const GPT2_TOKENIZER = 1;

/**
 * Switches the tokenizer setting to GPT-2 through its change handler.
 * @param {import('@playwright/test').Page} page
 */
async function switchToGpt2Tokenizer(page) {
    await page.evaluate(value => $('#tokenizer').val(String(value)).trigger('change'), GPT2_TOKENIZER);
}

test.describe('character editor counts while showing', () => {
    test.beforeEach(async ({ page }) => {
        await recordTokenizerSends(page);
        await testSetup.awaitST({ page });
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('a reload that auto-loads the character sends no count before the editor shows', async ({ page }) => {
        await page.evaluate(() => $('#auto-load-chat-checkbox').prop('checked', true).trigger('input'));
        const { name, marker } = await createCharacterAndCloseEditor(page);

        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
        await page.waitForTimeout(QUIET_MS);

        expect((await countsOf(page, marker)).filter(c => !c.showing)).toEqual([]);
    });

    test('a tokenizer change with the editor closed waits for the editor to open', async ({ page }) => {
        const { marker } = await createCharacterAndCloseEditor(page);
        const before = (await countsOf(page, marker)).length;

        await switchToGpt2Tokenizer(page);
        await page.waitForTimeout(QUIET_MS);
        expect(await countsOf(page, marker)).toHaveLength(before);

        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expect.poll(async () => (await countsOf(page, marker)).length, { timeout: 5000 }).toBe(before + 1);
        expect((await countsOf(page, marker)).at(-1).showing).toBe(true);
        await expect(page.locator('#result_info_total_tokens')).not.toHaveText('0');
        await page.waitForTimeout(QUIET_MS);
        expect(await countsOf(page, marker)).toHaveLength(before + 1);
    });

    test('a covering drawer closing over the editor counts a change made while it was covered', async ({ page }) => {
        const { marker } = await createCharacterAndCloseEditor(page);
        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        // Pinned, so opening character management covers the editor instead of closing it.
        const pin = page.locator('#charInfo_button_panel_pin');
        if (!(await pin.isChecked())) {
            await pin.evaluate(el => el.click());
        }
        await page.waitForTimeout(QUIET_MS);
        const before = (await countsOf(page, marker)).length;

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await expect(page.locator('#char-info-panel')).toBeHidden();
        await switchToGpt2Tokenizer(page);
        await page.waitForTimeout(QUIET_MS);
        expect(await countsOf(page, marker)).toHaveLength(before);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expect.poll(async () => (await countsOf(page, marker)).length, { timeout: 5000 }).toBe(before + 1);
        expect((await countsOf(page, marker)).at(-1).showing).toBe(true);
    });

    test('forceCharacterEditorTokenize() counts right away with the editor closed', async ({ page }) => {
        const { marker } = await createCharacterAndCloseEditor(page);
        const before = (await countsOf(page, marker)).length;
        await page.evaluate(async (tokenizer) => {
            const { power_user, forceCharacterEditorTokenize } = await import('/scripts/power-user.js');
            // Set without the setting's change handler, so the forced count is the only trigger.
            power_user.tokenizer = tokenizer;
            forceCharacterEditorTokenize();
        }, GPT2_TOKENIZER);
        await expect.poll(async () => (await countsOf(page, marker)).length, { timeout: 5000 }).toBe(before + 1);
        expect((await countsOf(page, marker)).at(-1).showing).toBe(false);
    });
});
