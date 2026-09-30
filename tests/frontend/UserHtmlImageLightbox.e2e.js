import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

const IMAGE = '/img/ai4.png';
const IMAGE_SRC = /\/img\/ai4\.png$/;

/** @param {import('@playwright/test').Page} page */
async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Starts a slash command script without waiting for it: a popup command only returns once its popup closes.
 * @param {import('@playwright/test').Page} page
 * @param {string} script
 */
async function runScript(page, script) {
    await page.evaluate(script => {
        window['SillyTavern'].getContext().executeSlashCommandsWithOptions(script);
    }, script);
}

/** @param {import('@playwright/test').Page} page */
function lightbox(page) {
    return page.locator('.img_enlarged_container img.img_enlarged');
}

/**
 * Expects the lightbox to show the test image, then closes it.
 * @param {import('@playwright/test').Page} page
 */
async function expectLightboxThenClose(page) {
    await expect(lightbox(page)).toBeVisible();
    await expect(lightbox(page)).toHaveAttribute('src', IMAGE_SRC);
    await page.keyboard.press('Escape');
    await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
}

/**
 * The open popup holding the given text, once its opening animation is over.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
function openPopup(page, text) {
    return page.locator('dialog.popup[open]:not([opening])', { hasText: text });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
function toastWith(page, text) {
    return page.locator('#toast-container .toast', { hasText: text });
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

test.describe('Lightbox on images in user-written HTML', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test.describe('chat message', () => {
        test.beforeEach(async ({ page }) => {
            await page.evaluate((image) => {
                const context = window['SillyTavern'].getContext();
                const message = {
                    name: 'Lightbox',
                    is_user: false,
                    is_system: false,
                    send_date: new Date().toISOString(),
                    mes: 'message words',
                    extra: {
                        reasoning: `reasoning words\n\n<img src="${image}" alt="in reasoning">`,
                        bias: `<img src="${image}" alt="in bias">`,
                    },
                };
                context.chat.push(message);
                context.addOneMessage(message);
            }, IMAGE);
            await expect(page.locator('#chat .mes').last().locator('.mes_text')).toHaveText('message words');
        });

        for (const clickToEdit of [true, false]) {
            test(`an image in the reasoning block shows in the lightbox (click to edit ${clickToEdit ? 'on' : 'off'})`, async ({ page }) => {
                const previous = await setClickToEdit(page, clickToEdit);
                try {
                    const message = page.locator('#chat .mes').last();
                    await message.locator('.mes_reasoning_details').evaluate(el => el.setAttribute('open', ''));
                    const image = message.locator('.mes_reasoning img');
                    await expect(image).toBeVisible();
                    await expect(image).toHaveCSS('cursor', 'pointer');

                    await image.click();

                    await expectLightboxThenClose(page);
                    await expect(page.locator('.edit_textarea')).toHaveCount(0);
                    await expect(page.locator('.reasoning_edit_textarea')).toHaveCount(0);
                } finally {
                    await setClickToEdit(page, previous);
                }
            });
        }

        test('an image in the bias shows in the lightbox', async ({ page }) => {
            const image = page.locator('#chat .mes').last().locator('.mes_bias img');
            await expect(image).toBeVisible();
            await expect(image).toHaveCSS('cursor', 'pointer');

            await image.click();

            await expectLightboxThenClose(page);
        });
    });

    test('an image in the regex debugger message render shows in the lightbox', async ({ page }) => {
        // The debugger renders nothing without a rule; this one leaves the input as it is.
        await page.evaluate(() => {
            window['SillyTavern'].getContext().extensionSettings.regex.push({
                id: 'lightbox-test-rule',
                scriptName: 'Lightbox test rule',
                findRegex: '/text-the-input-does-not-hold/g',
                replaceString: '',
                trimStrings: [],
                placement: [],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            });
        });
        await page.locator('#open_regex_debugger').evaluate(el => el.click());
        await page.locator('#regex_debugger_raw_input').fill(`debugger words <img src="${IMAGE}" alt="in debugger">`);
        await page.locator('#regex_debugger_render_mode').selectOption('message');
        await page.locator('#regex_debugger_run_test').click();
        const image = page.locator('#regex_debugger_final_output .mes .mes_text img');
        await expect(image).toBeVisible();
        await expect(image).toHaveCSS('cursor', 'pointer');

        await image.click();

        await expectLightboxThenClose(page);
        await expect(page.locator('#regex_debugger_final_output')).toBeVisible();
    });

    test.describe('STscript popup', () => {
        test('/popup: an image in the body and in the header shows in the lightbox', async ({ page }) => {
            await runScript(page, `/popup header="<img src='${IMAGE}' alt='in header' class='in_header'>" <img src="${IMAGE}" alt="in body" class="in_body"> popup words`);
            const popup = openPopup(page, 'popup words');
            await expect(popup).toBeVisible();

            for (const selector of ['img.in_body', 'h3 img.in_header']) {
                await expect(popup.locator(selector)).toHaveCSS('cursor', 'pointer');
                await popup.locator(selector).click();
                await expectLightboxThenClose(page);
                await expect(popup).toBeVisible();
            }

            await popup.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
        });

        test('/popup: an image that is a result control closes the popup and shows no lightbox', async ({ page }) => {
            await runScript(page, `/popup <img src="${IMAGE}" alt="button" data-result="1"> control words`);
            const popup = openPopup(page, 'control words');
            await expect(popup).toBeVisible();
            // Not a lightbox image, so it gets no pointer from the lightbox rule.
            await expect(popup.locator('.popup-content img')).not.toHaveCSS('cursor', 'pointer');

            await popup.locator('.popup-content img').click();

            await expect(popup).toHaveCount(0);
            await expect(page.locator('.img_enlarged_container')).toHaveCount(0);
        });

        test('/buttons: an image in the text shows in the lightbox', async ({ page }) => {
            await runScript(page, `/buttons labels=["one","two"] <img src="${IMAGE}" alt="in buttons"> buttons words`);
            const popup = openPopup(page, 'buttons words');
            await expect(popup).toBeVisible();

            await expect(popup.locator('.popup-content img')).toHaveCSS('cursor', 'pointer');
            await popup.locator('.popup-content img').click();

            await expectLightboxThenClose(page);
            await expect(popup).toBeVisible();
            await popup.locator('.menu_button', { hasText: 'one' }).click();
            await expect(popup).toHaveCount(0);
        });

        test('/input: an image in the prompt shows in the lightbox', async ({ page }) => {
            await runScript(page, `/input <img src="${IMAGE}" alt="in input"> input words`);
            const popup = openPopup(page, 'input words');
            await expect(popup).toBeVisible();

            await expect(popup.locator('.popup-content img')).toHaveCSS('cursor', 'pointer');
            await popup.locator('.popup-content img').click();

            await expectLightboxThenClose(page);
            await expect(popup).toBeVisible();
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
        });

        test('return=popup-html: an image in the returned value shows in the lightbox', async ({ page }) => {
            await runScript(page, `/comment return=popup-html <img src="${IMAGE}" alt="in return"> returned words`);
            const popup = openPopup(page, 'returned words');
            await expect(popup).toBeVisible();

            await expect(popup.locator('.popup-content img')).toHaveCSS('cursor', 'pointer');
            await popup.locator('.popup-content img').click();

            await expectLightboxThenClose(page);
            await expect(popup).toBeVisible();
            await popup.locator('.popup-button-ok').click();
            await expect(popup).toHaveCount(0);
        });
    });

    test.describe('STscript toast', () => {
        test('/echo escapeHtml=false: an image shows in the lightbox; the toast stays and its onClick does not run', async ({ page }) => {
            await runScript(page, `/echo escapeHtml=false timeout=0 extendedTimeout=0 onClick={: /echo closure ran :} <img src="${IMAGE}" alt="in toast" width="40"> <span>toast words</span>`);
            const toast = toastWith(page, 'toast words');
            await expect(toast).toBeVisible();

            await expect(toast.locator('img')).toHaveCSS('cursor', 'pointer');
            await toast.locator('img').click();

            await expectLightboxThenClose(page);
            await expect(toast).toBeVisible();
            await expect(toastWith(page, 'closure ran')).toHaveCount(0);

            // Outside the image the toast keeps its own click.
            await toast.locator('span', { hasText: 'toast words' }).click();
            await expect(toastWith(page, 'closure ran')).toBeVisible();
            await expect(toast).toHaveCount(0);
        });

        test('/echo escapeHtml=false: an image in the title shows in the lightbox', async ({ page }) => {
            await runScript(page, `/echo escapeHtml=false timeout=0 extendedTimeout=0 title="<img src='${IMAGE}' alt='in title'>" titled words`);
            const toast = toastWith(page, 'titled words');
            await expect(toast).toBeVisible();

            await expect(toast.locator('.toast-title img')).toHaveCSS('cursor', 'pointer');
            await toast.locator('.toast-title img').click();

            await expectLightboxThenClose(page);
            await expect(toast).toBeVisible();
        });

        test('return=toast-html: an image in the returned value shows in the lightbox', async ({ page }) => {
            await runScript(page, `/comment return=toast-html <img src="${IMAGE}" alt="in return"> returned words`);
            const toast = toastWith(page, 'returned words');
            await expect(toast).toBeVisible();

            await expect(toast.locator('img')).toHaveCSS('cursor', 'pointer');
            await toast.locator('img').click();

            await expectLightboxThenClose(page);
        });
    });
});
