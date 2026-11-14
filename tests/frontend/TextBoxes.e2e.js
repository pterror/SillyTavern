import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function openPersona(page) {
    await page.locator('#persona-management-button > .drawer-toggle').click();
    await expect(page.locator('#persona_description + .text_box')).toBeVisible();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function clickToEdit(page, on) {
    await page.evaluate(async (on) => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.click_to_edit = on;
    }, on);
}

const description = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#persona_description').inputValue();

test.describe('prompt text boxes', () => {
    test.beforeEach(testSetup.awaitST);

    test('show their text drawn by the reader, with macros as values, in place of the textarea', async ({ page }) => {
        await openPersona(page);
        await page.evaluate(() => {
            const area = /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description'));
            area.value = 'A *kind* traveller called {{user}}.';
        });
        const view = page.locator('#persona_description + .text_box .text_box_view');
        await expect(view.locator('em')).toHaveText('kind');
        await expect(view.locator('.macro-value')).toHaveCount(1);
        await expect(page.locator('#persona_description')).toBeHidden();
        await expect(page.locator('#persona_description + .text_box .cm-editor')).toHaveCount(0);
    });

    test('a double-click starts an edit in the shared editor with its toolbar; edits reach the textarea; confirm closes', async ({ page }) => {
        await openPersona(page);
        await clickToEdit(page, false);
        await page.evaluate(() => {
            /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description')).value = 'Hello world';
        });
        const box = page.locator('#persona_description + .text_box');
        await box.locator('.text_box_view').click();
        await expect(box.locator('.cm-editor')).toHaveCount(0);
        await box.locator('.text_box_view').dblclick();
        await expect(box.locator('.cm-editor')).toBeVisible();
        await expect(box.locator('.chat-editor-toolbar button[data-tool="bold"]')).toBeVisible();
        await expect(box.locator('.text_box_view')).toBeHidden();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('!');
        expect(await description(page)).toBe('Hello world!');
        await box.locator('.fa-check').click();
        await expect(box.locator('.cm-editor')).toHaveCount(0);
        await expect(box.locator('.text_box_view')).toContainText('Hello world!');
        expect(await description(page)).toBe('Hello world!');
    });

    test('a click starts the edit when click to edit is on; the pencil always does; cancel puts the text back', async ({ page }) => {
        await openPersona(page);
        await clickToEdit(page, true);
        await page.evaluate(() => {
            /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description')).value = 'Original';
        });
        const box = page.locator('#persona_description + .text_box');
        await box.locator('.text_box_view').click();
        await expect(box.locator('.cm-editor')).toBeVisible();
        await page.keyboard.type(' changed');
        expect(await description(page)).not.toBe('Original');
        await box.locator('.fa-xmark').click();
        expect(await description(page)).toBe('Original');
        await box.locator('.fa-pencil').click();
        await expect(box.locator('.cm-editor')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(box.locator('.cm-editor')).toHaveCount(0);
        await clickToEdit(page, false);
    });

    test('a macro typed in an edit shows its value', async ({ page }) => {
        await openPersona(page);
        await page.evaluate(() => {
            /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description')).value = 'Hi ';
        });
        const box = page.locator('#persona_description + .text_box');
        await box.locator('.fa-pencil').click();
        await page.keyboard.press('Control+End');
        await page.keyboard.type('{{user}}');
        await expect(box.locator('.macro-pill-mention')).toHaveCount(1);
        await box.locator('.fa-xmark').click();
    });

    test('the other prompt boxes are the same: an Author\'s Note, a quick prompt, a prompt manager prompt, a story string, an override', async ({ page }) => {
        const ids = await page.evaluate(() => [...document.querySelectorAll('textarea[data-text-box]')].map(el => el.id));
        expect(ids).toEqual(expect.arrayContaining([
            'persona_description', 'extension_floating_prompt', 'extension_floating_chara', 'extension_floating_default',
            'main_prompt_quick_edit_textarea', 'nsfw_prompt_quick_edit_textarea', 'jailbreak_prompt_quick_edit_textarea',
            'context_story_string', 'completion_prompt_manager_popup_entry_form_prompt',
            'instruct_input_sequence', 'instruct_output_suffix', 'context_example_separator', 'sysprompt_content',
            'reasoning_prefix', 'start_reply_with', 'chat_cfg_negative_prompt', 'global_cfg_positive_prompt',
            'nai_preamble_textarea', 'rm_group_generation_mode_join_prefix',
        ]));
        for (const id of ids) await expect(page.locator(`#${id} + .text_box`)).toHaveCount(1);
    });

    test('the expanded editor is the shared editor, bigger, writing into the field', async ({ page }) => {
        await openPersona(page);
        await page.evaluate(() => {
            /** @type {HTMLTextAreaElement} */ (document.querySelector('#persona_description')).value = 'Start';
        });
        await page.locator('.editor_maximize[data-for="persona_description"]').click();
        const expanded = page.locator('.expanded_editor');
        await expect(expanded.locator('.cm-editor')).toBeVisible();
        await expect(expanded.locator('.chat-editor-toolbar button[data-tool="bold"]')).toBeVisible();
        await expect(expanded.locator('textarea')).toHaveCount(0);
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' more {{user}}');
        expect(await description(page)).toBe('Start more {{user}}');
        await expect(expanded.locator('.macro-pill')).toHaveCount(1);
        const box = await expanded.locator('.cm-editor').boundingBox();
        expect(box?.height).toBeGreaterThan(300);
        await page.locator('.editorLayer .editorLayerClose, .editorLayer [title="Restore"]').first().click();
        await expect(expanded).toHaveCount(0);
        await expect(page.locator('#persona_description + .text_box .text_box_view')).toContainText('Start more');
    });

    test('the story string draws its Handlebars block tags as macros, in reading and in the editor', async ({ page }) => {
        const template = '{{#if description}}{{description}}{{else}}none{{/if}}';
        await page.evaluate((template) => {
            /** @type {HTMLTextAreaElement} */ (document.querySelector('#context_story_string')).value = template;
        }, template);
        const box = page.locator('#context_story_string + .text_box');
        const view = box.locator('.text_box_view');
        await expect(view.locator('.macro-block-tag')).toHaveText(['{{#if description}}', '{{else}}', '{{/if}}']);
        await expect(view.locator('.macro-value-unknown')).toHaveCount(0);
        expect(await view.locator('.macro-block-tag').first().evaluate(el => getComputedStyle(el).fontStyle)).toBe('normal');
        await page.evaluate(() => {
            for (let node = /** @type {HTMLElement | null} */ (document.querySelector('#context_story_string + .text_box')); node && node !== document.body; node = node.parentElement) {
                if (getComputedStyle(node).display === 'none') node.style.setProperty('display', 'block', 'important');
            }
        });
        await box.locator('.fa-pencil').click();
        const pills = box.locator('.cm-content .macro-pill');
        await expect(pills).toHaveCount(4);
        await expect(pills.first()).toContainText('#if description');
        await box.locator('.fa-xmark').click();
    });
});
