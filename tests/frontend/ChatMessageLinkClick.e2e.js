import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} value
 * @returns {Promise<boolean>} The previous value.
 */
async function setClickToEdit(page, value) {
    return page.evaluate(async (value) => {
        const { power_user } = await import('/scripts/power-user.js');
        const previous = power_user.click_to_edit;
        power_user.click_to_edit = value;
        return previous;
    }, value);
}

test.describe('Clicking a link in a chat message with click to edit on', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.evaluate(async () => {
            // Messages on the welcome screen cannot be edited; a temporary chat's can, and it saves nothing.
            const { newAssistantChat } = await import('/script.js');
            await newAssistantChat({ temporary: true });
            const context = window['SillyTavern'].getContext();
            const message = {
                name: 'Links',
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: 'message words\n\n[the message link](https://example.invalid/message)',
                extra: {
                    reasoning: 'reasoning words\n\n[the reasoning link](https://example.invalid/reasoning)',
                },
            };
            context.chat.push(message);
            context.addOneMessage(message);
            // The link must not leave the page under test; the app's own handlers still run.
            document.addEventListener('click', (event) => {
                if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
            }, true);
        });
        await expect(page.locator('#chat .mes').last().locator('.mes_text a[href]')).toHaveText('the message link');
    });

    test('a link in the message text does not enter edit mode; the words around it do', async ({ page }) => {
        const previous = await setClickToEdit(page, true);
        try {
            const message = page.locator('#chat .mes').last();

            await message.locator('.mes_text a[href]').click();
            await expect(page.locator('.edit_textarea')).toHaveCount(0);

            await message.locator('.mes_text').getByText('message words').click();
            await expect(page.locator('.edit_textarea')).toHaveCount(1);
        } finally {
            await setClickToEdit(page, previous);
        }
    });

    test('a link in the reasoning block does not enter edit mode; the words around it do', async ({ page }) => {
        const previous = await setClickToEdit(page, true);
        try {
            const message = page.locator('#chat .mes').last();
            await message.locator('.mes_reasoning_details').evaluate(el => el.setAttribute('open', ''));
            const link = message.locator('.mes_reasoning a[href]');
            await expect(link).toHaveText('the reasoning link');

            await link.click();
            await expect(page.locator('.edit_textarea')).toHaveCount(0);
            await expect(page.locator('.reasoning_edit_textarea')).toHaveCount(0);

            await message.locator('.mes_reasoning').getByText('reasoning words').click();
            await expect(page.locator('.edit_textarea')).toHaveCount(1);
        } finally {
            await setClickToEdit(page, previous);
        }
    });
});
