import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Mounts an editor that fills in macros the way a field does.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function mountWithMacros(page, value) {
    await page.evaluate(async (value) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const { renderMarkdown } = await import('/scripts/marked-processor.js');
        const { substituteParams } = await import('/script.js');
        const { evaluateSafeMacro } = await import('/scripts/safe-macros.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, {
            render: renderMarkdown,
            macros: { evaluate: (/** @type {string} */ text) => evaluateSafeMacro(text, substituteParams, { name2Override: 'Testchar' }) },
        });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, value);
}

test.describe('live editor macros', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('in the block being edited, macros are filled in except the one the cursor is in; ones that only run when sent stay as written', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} and {{random::a::b}}.');
        await page.locator('#liveEditorTestHost .live-unit').click();
        await page.evaluate(() => {
            // @ts-ignore
            const { editor } = window.liveEditorTest;
            editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
        });
        await expect(page.locator('#liveEditorTestHost .cm-line .macro-substituted')).toHaveText('Testchar');
        await expect(page.locator('#liveEditorTestHost .cm-line .macro-raw')).toHaveText('{{random::a::b}}');
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.editor.view.dispatch({ selection: { anchor: 9 } });
        });
        await expect(page.locator('#liveEditorTestHost .cm-line .macro-substituted')).toHaveCount(0);
        await expect(page.locator('#liveEditorTestHost .cm-line')).toContainText('{{char}}');
    });

    test('typing a macro shows the app\'s macro suggestions with the highlighted one\'s current value', async ({ page }) => {
        await mountWithMacros(page, 'x');
        await page.locator('#liveEditorTestHost .live-unit').click();
        await page.keyboard.press('End');
        await page.keyboard.type(' {{cha');
        const list = page.locator('#liveEditorTestHost .cm-tooltip-autocomplete');
        await expect(list).toBeVisible();
        await expect(list.locator('li[aria-selected="true"]')).toContainText('char');
        await expect(page.locator('#liveEditorTestHost .live-macro-value')).toHaveText('Now: Testchar');
        await page.keyboard.press('Enter');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('x {{char}}');
    });
});
