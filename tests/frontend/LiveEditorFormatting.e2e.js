import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Mounts an editor with the toolbar on a `.mdHotkeys` textarea, as the app's fields are, focused at the end.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 * @param {'ok'|'fail'} [upload]
 */
async function mountWithToolbar(page, value, upload = 'ok') {
    await page.evaluate(async ({ value, upload }) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.className = 'mdHotkeys';
        textarea.value = value;
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, {
            formatting: {
                uploadImage: async () => {
                    if (upload === 'fail') throw new Error('disk full');
                    return '/user/files/pic.png';
                },
            },
        });
        editor.view.focus();
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, { value, upload });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} anchor
 * @param {number} [head]
 */
async function select(page, anchor, head = anchor) {
    await page.evaluate(({ anchor, head }) => {
        // @ts-ignore
        window.liveEditorTest.editor.view.dispatch({ selection: { anchor, head } });
    }, { anchor, head });
}

const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestTextarea').inputValue();

test.describe('live editor toolbar and keys', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
            const { power_user } = await import('/scripts/power-user.js');
            power_user.enable_md_hotkeys = true;
        });
    });

    test('the markdown keys wrap and unwrap as in a textarea, once each', async ({ page }) => {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.enable_md_hotkeys = true;
        });
        await mountWithToolbar(page, 'one two three');
        await select(page, 4, 7);
        await page.keyboard.press('Control+b');
        expect(await value(page)).toBe('one **two** three');
        await page.keyboard.press('Control+b');
        expect(await value(page)).toBe('one two three');
        await select(page, 10);
        await page.keyboard.press('Control+i');
        expect(await value(page)).toBe('one two *three*');
        await page.keyboard.press('Control+k');
        expect(await value(page)).toBe('one two `*three*`');
    });

    test('with the markdown keys off, they do nothing', async ({ page }) => {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.enable_md_hotkeys = false;
        });
        await mountWithToolbar(page, 'word');
        await select(page, 0, 4);
        await page.keyboard.press('Control+b');
        expect(await value(page)).toBe('word');
    });

    test('toolbar buttons and the block type run the same formatting', async ({ page }) => {
        await mountWithToolbar(page, 'Title\nbody');
        await select(page, 6, 10);
        await page.locator('#liveEditorTestHost .live-toolbar-button.fa-bold').click();
        expect(await value(page)).toBe('Title\n**body**');
        await select(page, 2);
        await page.locator('#liveEditorTestHost .live-toolbar-block').selectOption('h2');
        expect(await value(page)).toBe('## Title\n**body**');
        await page.locator('#liveEditorTestHost .live-toolbar-block').selectOption('paragraph');
        expect(await value(page)).toBe('Title\n**body**');
    });

    test('the image button uploads the image and puts its markdown in place of a placeholder', async ({ page }) => {
        await mountWithToolbar(page, 'Look: ');
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#liveEditorTestHost .live-toolbar-button.fa-image').click();
        await (await chooser).setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Look: ![pic.png](/user/files/pic.png)');
    });

    test('a failed upload takes the placeholder away and says why', async ({ page }) => {
        await mountWithToolbar(page, 'Look: ', 'fail');
        const chooser = page.waitForEvent('filechooser');
        await page.locator('#liveEditorTestHost .live-toolbar-button.fa-image').click();
        await (await chooser).setFiles({ name: 'pic.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
        await expect(page.locator('.toast-error')).toContainText('disk full');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Look: ');
    });
});
