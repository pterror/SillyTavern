import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers, chatBox } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} command
 */
function runSlash(page, command) {
    return page.evaluate(async (text) => {
        const result = await window['stTest'].context().executeSlashCommandsWithOptions(text);
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
        const chatLength = await page.evaluate(() => window['stTest'].context().chat.length);
        expect(await runSlash(page, '/help')).toBe('');
        await expect(panel(page)).toBeVisible();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'overview');
        expect(await page.evaluate(() => window['stTest'].context().chat.length)).toBe(chatLength);
        expect(await page.locator('dialog[open]').count()).toBe(0);

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
            await chatBox(page).click();
            await page.keyboard.type('still usable');
            await expect(chatBox(page)).toHaveText('still usable');
            await chatBox(page).fill('');
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
        await page.locator('.helpLayer .helpContent a', { hasText: 'Slash Commands' }).click();
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'slash');
        await expect(page.locator('.helpLayer .slashCommandBrowser')).toBeVisible();
    });

    test('the search box searches every topic at once, asking the server nothing', async ({ page }) => {
        await runSlash(page, '/help');
        const search = page.locator('.helpLayer .helpSearch');
        await expect(search).toBeVisible();
        /** @type {string[]} */
        const asked = [];
        page.on('request', request => {
            if (request.url().includes('/api/')) asked.push(request.url());
        });

        await search.fill('strikethrough');
        await expect(page.locator('.helpLayer .helpSection[data-topic="hotkeys"]')).toBeVisible();
        await expect(page.locator('.helpLayer .helpTopic[data-topic="hotkeys"] .helpTopicCount')).toHaveText('1');
        await expect(page.locator('.helpLayer .helpSection[data-topic="macros"]')).toBeHidden();

        await search.fill('"echo"');
        await expect(page.locator('.helpLayer .helpSection[data-topic="slash"]')).toBeVisible();
        await expect(page.locator('.helpLayer .helpSection[data-topic="slash"] .autoComplete > :not(.isFiltered)').first()).toBeVisible();

        await search.fill('zzqqxxnomatchzz');
        await expect(page.locator('.helpLayer .helpNoResults')).toBeVisible();

        await search.fill('');
        await expect(activeTopic(page)).toHaveAttribute('data-topic', 'overview');
        expect(asked).toEqual([]);
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

});

test.describe('Hotkeys', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    const overlay = page => page.locator('.commandCheatsheet:popover-open');
    /** @param {import('@playwright/test').Locator} locator */
    const rectOf = locator => locator.evaluate(element => element.getBoundingClientRect().toJSON());

    test('the Hotkeys topic lists the registered commands by category, each with its keys', async ({ page }) => {
        await runSlash(page, '/help hotkeys');
        const content = page.locator('.helpLayer .helpContent');
        const group = category => content.locator('.hotkeyGroup', { has: page.locator('.hotkeyGroupTitle', { hasText: new RegExp(`^${category}$`) }) });
        const row = (category, label) => group(category).locator('.hotkeyItem', { has: page.locator('.hotkeyLabel', { hasText: new RegExp(`^${label}$`) }) });
        await expect(row('Chat', 'Send message').locator('.hotkeyKeys > span').first().locator('kbd')).toHaveText(['↵']);
        await expect(row('General', 'Command palette').locator('.hotkeyKeys > span').first().locator('kbd')).toHaveText(['Ctrl', 'K']);
    });

    test('holding Ctrl on its own shows the cheatsheet while the chat box keeps focus; letting go hides it', async ({ page }) => {
        await chatBox(page).focus();
        await page.keyboard.down('Control');
        await expect(overlay(page)).toBeVisible();
        await expect(chatBox(page)).toBeFocused();
        await page.keyboard.up('Control');
        await expect(overlay(page)).toHaveCount(0);
        await expect(chatBox(page)).toBeFocused();
    });

    test('with the cheatsheet shown, the rest of a shortcut still runs it', async ({ page }) => {
        await chatBox(page).focus();
        await page.keyboard.down('Control');
        await expect(overlay(page)).toBeVisible();
        await page.keyboard.press('Shift+P');
        await page.keyboard.up('Control');
        await expect(overlay(page)).toHaveCount(0);
        await expect(page.locator('.commandPalette [role=combobox]')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('.commandPalette')).toBeHidden();
    });

    test('Shift+? shows the cheatsheet without taking focus, and Escape closes only it', async ({ page }) => {
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        const focused = await page.evaluateHandle(() => document.activeElement);
        await page.keyboard.press('Shift+Slash');
        await expect(overlay(page)).toBeVisible();
        expect(await page.evaluate(was => document.activeElement === was, focused)).toBe(true);
        await page.keyboard.press('Escape');
        await expect(overlay(page)).toHaveCount(0);
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#user-settings-block')).toHaveClass(/closedDrawer/);
    });

    test('the list puts categories side by side, keys beside their command, a command\'s bindings further apart than a binding\'s keys', async ({ page }) => {
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('Shift+Slash');
        const sheet = overlay(page);
        await expect(sheet).toHaveAttribute('role', 'region');
        await expect(sheet).toHaveAccessibleName('Keyboard shortcuts');
        await expect(sheet).toHaveAttribute('tabindex', '0');

        const group = name => sheet.locator('[role=group]', { has: page.getByText(name, { exact: true }) });
        const fields = await rectOf(group('Fields and lists'));
        const general = await rectOf(group('General'));
        expect(general.top).toBe(fields.top);
        expect(general.left).toBeGreaterThan(fields.right);

        const row = group('General').locator('div', { hasText: 'Command palette' });
        const keys = row.locator('kbd');
        await expect(keys).toHaveText(['Ctrl', 'K', 'Ctrl', 'Shift', 'P']);
        const label = await rectOf(row.locator(':scope > span').first());
        const [ctrl, k, nextCtrl] = await Promise.all([0, 1, 2].map(i => rectOf(keys.nth(i))));
        expect(Math.abs((ctrl.top + ctrl.bottom) / 2 - (label.top + label.bottom) / 2)).toBeLessThan(2);
        const inBinding = k.left - ctrl.right;
        expect(inBinding).toBeGreaterThan(0);
        expect(nextCtrl.left - k.right).toBeGreaterThan(inBinding * 2);
    });

    test('with stacked drawers on, the held list is a layer: the chat under it is cut there, and back once it hides', async ({ page }) => {
        await setStackedDrawers(page, true);
        await chatBox(page).focus();
        await page.keyboard.down('Control');
        await expect(overlay(page)).toBeVisible();
        await expect(page.locator('#sheld')).toHaveAttribute('data-stack-cut', 'true');
        await page.keyboard.up('Control');
        await expect(overlay(page)).toHaveCount(0);
        await expect(page.locator('#sheld')).not.toHaveAttribute('data-stack-cut', 'true');
    });

    test('a shortcut while Ctrl is down keeps it from showing', async ({ page }) => {
        await chatBox(page).focus();
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.waitForTimeout(1500);
        await expect(overlay(page)).toHaveCount(0);
        await page.keyboard.up('Control');
    });

    test('the setting turns it off', async ({ page }) => {
        await page.keyboard.down('Control');
        await expect(overlay(page)).toContainText('Command palette');
        await expect(overlay(page)).not.toContainText('at the pointer');
        await page.keyboard.up('Control');

        const toggle = page.locator('#hotkey_overlay');
        await expect(toggle).toBeChecked();
        await toggle.evaluate(el => { /** @type {HTMLInputElement} */ (el).checked = false; el.dispatchEvent(new Event('input', { bubbles: true })); });
        try {
            await page.keyboard.down('Control');
            await page.waitForTimeout(1500);
            await expect(overlay(page)).toHaveCount(0);
            await page.keyboard.up('Control');
        } finally {
            await toggle.evaluate(el => { /** @type {HTMLInputElement} */ (el).checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); });
        }
    });
});
