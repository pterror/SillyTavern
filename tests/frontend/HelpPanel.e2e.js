import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Runs a slash command and returns its result.
 * @param {import('@playwright/test').Page} page
 * @param {string} command
 */
function runSlash(page, command) {
    return page.evaluate(async (text) => {
        const result = await window['SillyTavern'].getContext().executeSlashCommandsWithOptions(text);
        return result?.pipe;
    }, command);
}

const panel = page => page.locator('.helpLayer');
const activeTopic = page => page.locator('.helpLayer .helpTopic.active');

test.describe('Help panel', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('/help opens the panel without adding to the chat or blocking the page', async ({ page }) => {
        const chatLength = await page.evaluate(() => window['SillyTavern'].getContext().chat.length);
        expect(await runSlash(page, '/help')).toBe('');
        await expect(panel(page)).toBeVisible();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'overview');
        expect(await page.evaluate(() => window['SillyTavern'].getContext().chat.length)).toBe(chatLength);
        expect(await page.locator('dialog[open]').count()).toBe(0);

        // Nothing is blocked: a drawer outside the panel opens while help is open, and help stays open.
        await page.locator('#leftNavDrawerIcon').click();
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
        await expect(panel(page)).toBeVisible();
        await page.locator('#leftNavDrawerIcon').click();
    });

    test('with stacked drawers on, the chat comes forward over help and help comes back on click', async ({ page }) => {
        await setStackedDrawers(page, true);
        try {
            await runSlash(page, '/help');
            await page.locator('#chatDrawerIcon').click();
            await page.locator('#send_textarea').click();
            await page.keyboard.type('still usable');
            await expect(page.locator('#send_textarea')).toHaveValue('still usable');
            await page.locator('#send_textarea').fill('');
            await expect(panel(page)).toBeAttached();
        } finally {
            await setStackedDrawers(page, false);
        }
    });

    test('every name and number upstream accepts opens the same topic', async ({ page }) => {
        const cases = {
            slash: 'slash', commands: 'slash', slashes: 'slash', 'slash commands': 'slash', 1: 'slash',
            format: 'format', formatting: 'format', formats: 'format', 'chat formatting': 'format', 2: 'format',
            hotkeys: 'hotkeys', hotkey: 'hotkeys', 3: 'hotkeys',
            macros: 'macros', macro: 'macros', 4: 'macros',
            SLASH: 'slash', nonsense: 'overview',
        };
        for (const [name, topic] of Object.entries(cases)) {
            await runSlash(page, `/help ${name}`);
            await expect(activeTopic(page), `/help ${name}`).toHaveAttribute('data-topic', topic);
        }
        // Opening help again reuses the one panel.
        await expect(panel(page)).toHaveCount(1);
    });

    test('the options menu has Help as its last entry, and it opens the overview', async ({ page }) => {
        const last = page.locator('#options .options-content > a').last();
        await expect(last).toHaveId('option_help');
        await page.locator('#options_button').click();
        await page.locator('#option_help').click();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'overview');
    });

    test('topics switch from the list and from the overview\'s links', async ({ page }) => {
        await runSlash(page, '/help');
        await page.locator('.helpLayer .helpTopic[data-topic="format"]').click();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'format');
        await expect(page.locator('.helpLayer .helpContent')).toContainText('italics');

        await page.locator('.helpLayer .helpTopic[data-topic="overview"]').click();
        await page.locator('.helpLayer .helpContent [data-displayHelp="1"]').click();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'slash');
        await expect(page.locator('.helpLayer .slashCommandBrowser')).toBeVisible();
    });

    test('the search box searches every topic at once', async ({ page }) => {
        await runSlash(page, '/help');
        const search = page.locator('.helpLayer .helpSearch');

        await search.fill('strikethrough');
        await expect(page.locator('.helpLayer .helpSection[data-topic="hotkeys"]')).toBeVisible();
        await expect(page.locator('.helpLayer .helpTopic[data-topic="hotkeys"] .helpTopicCount')).toHaveText('1');
        // Topics without a match are left out of the results and the list.
        await expect(page.locator('.helpLayer .helpSection[data-topic="macros"]')).toHaveCount(0);

        // The slash command topic is searched with the slash command browser's own matching.
        await search.fill('"echo"');
        await expect(page.locator('.helpLayer .helpSection[data-topic="slash"]')).toBeVisible();
        await expect(page.locator('.helpLayer .helpSection[data-topic="slash"] .autoComplete > :not(.isFiltered)').first()).toBeVisible();

        await search.fill('zzqqxxnomatchzz');
        await expect(page.locator('.helpLayer .helpNoResults')).toBeVisible();

        // Clearing the search goes back to the topic that was open.
        await search.fill('');
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'overview');
    });

    test('on a narrow screen the topic list sits behind the menu button', async ({ page }) => {
        await page.setViewportSize({ width: 800, height: 900 });
        await runSlash(page, '/help');
        const nav = page.locator('.helpLayer .helpNav');
        const button = page.locator('.helpLayer .helpMenuButton');
        await expect(nav).toBeHidden();
        await expect(button).toBeVisible();
        await button.click();
        await expect(nav).toBeVisible();
        await expect(page.locator('.helpLayer .helpSearch')).toBeVisible();
        await page.locator('.helpLayer .helpTopic[data-topic="macros"]').click();
        await expect(nav).toBeHidden();
        await expect(page.locator('.helpLayer .macroBrowser')).toBeVisible();
    });

    test('the X and Escape close it', async ({ page }) => {
        await runSlash(page, '/help');
        await page.locator('.helpLayer .editorLayerClose').click();
        await expect(panel(page)).toHaveCount(0);

        await runSlash(page, '/help');
        await page.locator('.helpLayer .helpSearch').focus();
        await page.keyboard.press('Escape');
        await expect(panel(page)).toHaveCount(0);
    });

    test('extensions can add a topic, reachable by /help and listed', async ({ page }) => {
        await page.evaluate(() => {
            window['SillyTavern'].getContext().registerHelpTopic({
                id: 'my-extension',
                title: 'My Extension',
                aliases: ['myext'],
                order: 60,
                render(container, query) {
                    container.innerHTML = '<ul><li>first line about apples</li><li>second line about pears</li></ul>';
                    if (query) {
                        for (const li of container.querySelectorAll('li')) {
                            if (!li.textContent.includes(query)) li.remove();
                        }
                        return container.querySelectorAll('li').length;
                    }
                },
            });
        });
        await runSlash(page, '/help myext');
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'my-extension');
        await expect(page.locator('.helpLayer .helpContent')).toContainText('apples');

        await page.locator('.helpLayer .helpSearch').fill('pears');
        await expect(page.locator('.helpLayer .helpTopic[data-topic="my-extension"] .helpTopicCount')).toHaveText('1');
    });
});
