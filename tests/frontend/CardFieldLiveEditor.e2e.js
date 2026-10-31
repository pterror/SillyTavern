import { test, expect } from './fixtures.js';
import { testSetup, openInfoTab } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} values
 * @returns {Promise<string>}
 */
async function createAndOpen(page, values) {
    const avatar = await page.evaluate(async (values) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const form = new FormData();
        form.append('ch_name', `LiveCard-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        form.append('first_mes', 'Greeting');
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        const headers = ctx.getRequestHeaders();
        delete headers['Content-Type'];
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        return (await response.text()).trim();
    }, values);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().selectCharacterById(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function stored(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return (await response.json()).data;
    }, avatar);
}

test.describe('card fields edit in the live editor', () => {
    test.beforeEach(testSetup.awaitST);

    test('the pencil opens the editor on the field; typing and ✓ save, and the preview shows the result', async ({ page }) => {
        const avatar = await createAndOpen(page, { description: 'Old *text*.' });
        await openInfoTab(page, 'description');
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        const editor = page.locator('#charInfoTab_description .cm-editor');
        await expect(editor).toBeVisible();
        await expect(page.locator('#description_textarea')).toHaveClass(/live-editor-textarea/);
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' New **bold**.');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        await expect(editor).toHaveCount(0);
        await expect(page.locator('.field_preview[data-for="description_textarea"] strong')).toHaveText('bold');
        await expect.poll(async () => (await stored(page, avatar)).description).toBe('Old *text*. New **bold**.');
    });

    test('double-clicking a word in the preview starts the edit in that word, past markup and list numbers', async ({ page }) => {
        const description = '1. First *item* here\n2. Second **item** with the target word\n\n> the target again';
        await createAndOpen(page, { description });
        await openInfoTab(page, 'description');
        const preview = page.locator('.field_preview[data-for="description_textarea"]');
        await expect(preview.locator('li')).toHaveCount(2);
        await expect(preview.locator('li').nth(1)).toBeVisible();
        const top = () => preview.evaluate(el => Math.round(el.getBoundingClientRect().top));
        const seen = [];
        await expect.poll(async () => {
            seen.push(await top());
            return seen.length >= 3 && seen.slice(-3).every(v => v === seen.at(-1));
        }, { intervals: [250], timeout: 15000 }).toBe(true);
        for (const k of [0, 1]) {
            const point = await preview.evaluate((el, k) => {
                const found = [];
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    let i = -1;
                    while ((i = String(n.textContent).indexOf('target', i + 1)) >= 0) found.push({ n, i });
                }
                const range = document.createRange();
                range.setStart(found[k].n, found[k].i + 3);
                range.setEnd(found[k].n, found[k].i + 4);
                const b = range.getBoundingClientRect();
                return { x: b.left + 1, y: b.top + b.height / 2 };
            }, k);
            await page.mouse.dblclick(point.x, point.y);
            const editor = page.locator('#charInfoTab_description .cm-editor');
            await expect(editor).toBeVisible();
            const head = await page.evaluate(async () => {
                const lib = await import('/live-editor-lib.js');
                const view = lib.view.EditorView.findFromDOM(/** @type {HTMLElement} */ (document.querySelector('#charInfoTab_description .cm-editor')));
                return view?.state.selection.main.head;
            });
            expect(head).toBe([...description.matchAll(/target/g)][k].index + 3);
            await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();
            await expect(editor).toHaveCount(0);
        }
    });

    test('Escape with the macro suggestions open closes them and keeps editing', async ({ page }) => {
        await createAndOpen(page, { scenario: 'x' });
        await openInfoTab(page, 'scenario');
        await page.locator('.field_edit_toggle[data-for="scenario_pole"]').click();
        await expect(page.locator('#charInfoTab_scenario .cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' {{cha');
        await expect(page.locator('#charInfoTab_scenario .cm-tooltip-autocomplete')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#charInfoTab_scenario .cm-tooltip-autocomplete')).toHaveCount(0);
        await expect(page.locator('#charInfoTab_scenario .cm-editor')).toBeVisible();
        await page.locator('.field_edit_cancel[data-for="scenario_pole"]').click();
    });

    test('Ctrl+Enter saves without adding a line', async ({ page }) => {
        const avatar = await createAndOpen(page, { personality: 'kind' });
        await openInfoTab(page, 'personality');
        await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
        await expect(page.locator('#charInfoTab_personality .cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' and brave');
        await page.keyboard.press('Control+Enter');
        await expect(page.locator('#charInfoTab_personality .cm-editor')).toHaveCount(0);
        await expect.poll(async () => (await stored(page, avatar)).personality).toBe('kind and brave');
    });
});
