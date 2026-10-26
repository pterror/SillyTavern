import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers, stackMismatches, chatBox } from './frontent-test-utils.js';

// With stacked drawers on, whatever floats above the layers cuts what it covers under it, as a drawer does: popups,
// popovers, the search pickers, suggestion lists and the editors' tooltips, found by what they are.

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

/** Lets a slide or pop-in finish. */
const settle = (/** @type {import('@playwright/test').Page} */ page) => page.waitForTimeout(700);

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} overlay
 * @param {string} under The layer it is over
 */
async function expectOccludes(page, overlay, under) {
    await settle(page);
    await expect(page.locator(under)).toHaveAttribute('data-stack-cut', 'true');
    expect(await stackMismatches(page, { overlays: overlay })).toEqual([]);
}

test.describe('stacked drawers', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
        await openCharacterManagementDrawer(page);
        await page.locator('.character_select', { hasText: 'Alice' }).first().click();
        await expect(page.locator('#chatDrawerIcon')).toHaveClass(/stackFront/);
    });

    test('a popup over the chat cuts it', async ({ page }) => {
        // Every popup is one (the itemized prompt, a macro's text preview, ...).
        await page.evaluate(() => { void window['SillyTavern'].getContext().callGenericPopup('A popup over the chat.', 1); });
        await expect(page.locator('dialog.popup[open]')).toBeVisible();
        await expectOccludes(page, 'dialog[open]', '#sheld');
    });

    test('a layer blurs what is behind it itself; nothing inside it outside the top layer blurs', async ({ page }) => {
        // Firefox draws a blurring box on a layer of its own and doesn't clip it by its ancestor's cut.
        const found = await page.evaluate(() => {
            document.body.classList.remove('no-blur');
            const blurs = (/** @type {Element} */ el) => getComputedStyle(el).backdropFilter !== 'none';
            const layers = [...document.querySelectorAll('#sheld, .drawer-content, #movingDivs > *, body > .draggable')];
            return {
                sheld: blurs(document.getElementById('sheld')),
                inside: layers.flatMap(layer => [...layer.querySelectorAll('*')])
                    .filter(el => !el.closest('dialog, [popover]') && blurs(el))
                    .map(el => el.id || el.className),
            };
        });
        expect(found).toEqual({ sheld: true, inside: [] });
    });

    test('the talkativeness popover cuts character info under it', async ({ page }) => {
        await page.locator('#talkativeness_button').click();
        await expect(page.locator('#talkativeness_div')).toBeVisible();
        await expectOccludes(page, '#talkativeness_div', '#char-info-panel');
    });

    test('the search pill and saved view pickers cut character management under them', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
        await page.locator('#character_search_bar').pressSequentially('name:bob ');
        await page.locator('#character_search_pills .search_pill[data-field] .search_pill_label').click();
        await expect(page.locator('.view_pill_popover')).toBeVisible();
        await expectOccludes(page, '.view_pill_popover', '#right-nav-panel');

        await page.keyboard.press('Escape');
        await expect(page.locator('.view_pill_popover')).toHaveCount(0);
        await page.locator('#character_view_picker').click();
        await expect(page.locator('.view_picker_popover')).toBeVisible();
        await expectOccludes(page, '.view_picker_popover', '#right-nav-panel');
    });

    test('the slash command suggestions cut the chat under them', async ({ page }) => {
        await chatBox(page).click();
        await page.keyboard.type('/sen');
        await expect(page.locator('.autoComplete-wrap')).toBeVisible();
        await expectOccludes(page, '.autoComplete-wrap, .autoComplete-detailsWrap', '#sheld');
    });

    test('an editor\'s macro suggestions and paste picker cut the chat under them', async ({ page }) => {
        // An editor over the chat that isn't a layer itself, so only its tooltips are over the chat.
        await page.evaluate(async () => {
            const { mountLiveEditor } = await import('/scripts/live-editor/registry.js');
            const host = document.createElement('div');
            host.id = 'stackTestEditorHost';
            host.style.cssText = 'position:fixed;top:120px;left:420px;width:400px;pointer-events:none';
            const textarea = document.createElement('textarea');
            host.append(textarea);
            document.body.append(host);
            const editor = await mountLiveEditor(textarea, { formatting: false, macros: { values: { get: () => null, wantMacros: async () => false, refresh: async () => false } } });
            editor.view.focus();
            window['__stackTestEditor'] = editor;
        });
        await page.keyboard.type('Hi {{cha');
        await expect(page.locator('#stackTestEditorHost .cm-tooltip-autocomplete')).toBeVisible();
        await expectOccludes(page, '.cm-tooltip, .cm-completionInfo', '#sheld');

        await page.keyboard.press('Escape');
        await expect(page.locator('#stackTestEditorHost .cm-tooltip')).toHaveCount(0);
        await page.locator('#stackTestEditorHost .cm-content').evaluate(content => {
            const transfer = new DataTransfer();
            transfer.setData('text/html', '<p>Hello <b>bold</b>.</p>');
            transfer.setData('text/plain', 'Hello bold.');
            content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        });
        await expect(page.locator('#stackTestEditorHost .live-paste-picker')).toBeVisible();
        await expectOccludes(page, '.cm-tooltip', '#sheld');
        await page.evaluate(() => {
            window['__stackTestEditor'].destroy();
            document.getElementById('stackTestEditorHost').remove();
        });
    });

    test('the loading overlay covers the whole screen', async ({ page }) => {
        await page.evaluate(async () => {
            const { loader } = await import('/scripts/action-loader.js');
            window['__stackTestLoader'] = loader.show({ toastMode: loader.ToastMode.NONE });
        });
        const dialog = page.locator('dialog.popup[open]:has(#loader)');
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(el => {
            const box = el.getBoundingClientRect();
            return [box.left, box.top, box.width, box.height];
        })).toEqual([0, 0, 1400, 900]);
        await page.evaluate(() => window['__stackTestLoader'].hide());
    });
});
