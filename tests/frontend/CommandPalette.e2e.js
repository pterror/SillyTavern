import { test, expect } from './fixtures.js';
import { chatBox, testSetup } from './frontent-test-utils.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Seraphina's chat with a message of the person's and a reply with two swipes, the second shown
 * @param {import('@playwright/test').Page} page
 */
async function openChat(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        const { executeSlashCommandsWithOptions: run } = stTest.context();
        await run('/go Seraphina');
        await run('/send hello');
        await run('/sendas name=Seraphina first reply');
        await run('/addswipe switch=true second reply');
    });
    await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');
    await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
const lastSwipe = page => page.evaluate(() => {
    // @ts-ignore
    return stTest.context().chat.at(-1).swipe_id;
});

test.describe('commands', () => {
    test('the palette opens on Ctrl+K, lists commands with their keys, filters as one types, and runs one', async ({ page }) => {
        await openChat(page);
        await chatBox(page).click();
        await page.keyboard.press(`${MOD}+k`);
        const palette = page.locator('.commandPalette');
        await expect(palette).toBeVisible();
        expect(await palette.evaluate(element => element.matches(':popover-open'))).toBe(true);
        await expect(palette.locator('[role=combobox]')).toBeFocused();
        await expect(palette.locator('[role=option]', { hasText: 'Scroll to the bottom' })).toContainText('Shift');
        await expect(palette.locator('[role=option]', { hasText: 'at the pointer' })).toHaveCount(0);
        await page.keyboard.type('edit last');
        await expect(palette.locator('[role=option]').first()).toContainText('Edit last message');
        await page.keyboard.press('Enter');
        await expect(palette).toBeHidden();
        await expect(page.locator('#chat .last_mes .mes_editor')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#chat .mes_editor')).toHaveCount(0);
    });

    test('Ctrl+Shift+P opens the palette too, and Escape closes it, giving focus back', async ({ page }) => {
        await openChat(page);
        await chatBox(page).click();
        await page.keyboard.press(`${MOD}+Shift+p`);
        await expect(page.locator('.commandPalette [role=combobox]')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('.commandPalette')).toBeHidden();
        await expect(chatBox(page)).toBeFocused();
    });

    test('Escape in the palette closes only the palette, not the drawer under it', async ({ page }) => {
        await openChat(page);
        await page.locator('#user-settings-button .drawer-toggle').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await page.keyboard.press(`${MOD}+k`);
        await expect(page.locator('.commandPalette [role=combobox]')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(page.locator('.commandPalette')).toBeHidden();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
    });

    test('keys from the empty chat box: Left swipes, Up edits the last message, Escape leaves the edit', async ({ page }) => {
        await openChat(page);
        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => lastSwipe(page)).toBe(0);
        await page.keyboard.press('ArrowUp');
        await expect(page.locator('#chat .last_mes .mes_editor')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#chat .mes_editor')).toHaveCount(0);
        await expect(chatBox(page)).toBeFocused();
    });

    test('Enter in the chat box sends', async ({ page }) => {
        await testSetup.awaitST({ page });
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/go Seraphina');
            const { power_user } = await import('/scripts/power-user.js');
            power_user.send_on_enter = 1;
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        await chatBox(page).click();
        await page.keyboard.type('sent by Enter');
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return stTest.context().chat.some(message => message.is_user && message.mes === 'sent by Enter');
        })).toBe(true);
        await page.evaluate(() => {
            // @ts-ignore
            stTest.context().stopGeneration?.();
        });
    });

    test('a right click on a message opens its actions instead of the browser menu', async ({ page }) => {
        await openChat(page);
        const message = page.locator('#chat .mes').first();
        const prevented = page.evaluate(() => new Promise(resolve => {
            document.addEventListener('contextmenu', event => resolve(event.defaultPrevented), { once: true });
        }));
        await message.locator('.mes_text').click({ button: 'right' });
        expect(await prevented).toBe(true);
        const menu = page.locator('.commandMenu');
        await expect(menu).toBeVisible();
        await expect(menu.locator('[role=menuitem]').first()).toContainText('Edit');
        await expect(menu.locator('[role=menuitem]', { hasText: 'Copy' })).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await message.locator('.mes_text').click({ button: 'right' });
        await menu.locator('[role=menuitem]', { hasText: 'Edit' }).click();
        await expect(menu).toBeHidden();
        await expect(message.locator('.mes_editor')).toHaveCount(1);
    });

    test('the right-click menu acts on the message data and enables what its data allows', async ({ page }) => {
        await openChat(page);
        const message = page.locator('#chat .mes[is_user="true"]').last();
        const id = Number(await message.getAttribute('mesid'));
        const menu = page.locator('.commandMenu');
        await message.locator('.mes_text').click({ button: 'right' });
        await expect(menu.locator('[role=menuitem]', { hasText: 'Include in prompts' })).toBeDisabled();
        await menu.locator('[role=menuitem]', { hasText: 'Exclude from prompts' }).click();
        await expect(menu).toBeHidden();
        await expect.poll(() => page.evaluate(at => {
            // @ts-ignore
            return stTest.context().chat[at].is_system;
        }, id)).toBe(true);
        await message.locator('.mes_text').click({ button: 'right' });
        await expect(menu.locator('[role=menuitem]', { hasText: 'Exclude from prompts' })).toBeDisabled();
        await menu.locator('[role=menuitem]', { hasText: 'Include in prompts' }).click();
        await expect.poll(() => page.evaluate(at => {
            // @ts-ignore
            return stTest.context().chat[at].is_system;
        }, id)).toBe(false);
    });

    test('a key rebound is the command key from then on, and is kept in the person settings', async ({ page }) => {
        await openChat(page);
        await page.evaluate(async () => {
            const { newUi } = await import('/scripts/new-ui-page.js');
            newUi().commands.overrides.set({ 'palette.open': { keys: ['$mod+shift+k'] } });
        });
        await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
        await page.keyboard.press(`${MOD}+k`);
        await expect(page.locator('.commandPalette')).toBeHidden();
        await page.keyboard.press(`${MOD}+Shift+k`);
        await expect(page.locator('.commandPalette [role=combobox]')).toBeFocused();
        const kept = await page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.keybindings);
        expect(kept).toEqual({ 'palette.open': { keys: ['$mod+shift+k'] } });
    });

    test('a command rebound in the Keys settings runs from its new key, is kept, and resets', async ({ page }) => {
        await openChat(page);
        const kept = () => page.evaluate(async () => (await import('/scripts/power-user.js')).power_user.keybindings);
        const cheatsheet = page.locator('.commandCheatsheet:popover-open');
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        const row = page.locator('.keyBindings [role=group] > div', { has: page.locator('xpath=span[1][normalize-space()="Keyboard shortcuts"]') });
        await expect(row.locator('[data-keybinds=keys]')).toHaveCount(1);

        await row.locator('[data-keybinds=add]', { hasText: 'Key' }).click();
        await expect(row.locator('[data-keybinds=prompt]')).toBeVisible();
        await page.keyboard.press(`${MOD}+Shift+y`);
        await expect(row.locator('[data-keybinds=keys]')).toHaveCount(2);
        await expect(row).toHaveAttribute('data-changed', '');
        expect(await kept()).toEqual({ 'keys.show': { keys: ['shift+slash', '$mod+shift+y'] } });

        await page.keyboard.press(`${MOD}+Shift+y`);
        await expect(cheatsheet).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(cheatsheet).toHaveCount(0);

        // A key another command has is asked about, and doesn't run that command while it is recorded
        await row.locator('[data-keybinds=keys]').last().click();
        await page.keyboard.press(`${MOD}+k`);
        await expect(row.locator('[data-keybinds=conflict]')).toContainText('Command palette');
        await expect(page.locator('.commandPalette')).toBeHidden();
        await row.locator('[data-keybinds=cancel]').click();
        await expect(row.locator('[data-keybinds=conflict]')).toHaveCount(0);

        await row.locator('[data-keybinds=reset]').click();
        await expect(row.locator('[data-keybinds=keys]')).toHaveCount(1);
        await expect(row).not.toHaveAttribute('data-changed', '');
        expect(await kept()).toEqual({});
        await page.keyboard.press(`${MOD}+Shift+y`);
        await expect(cheatsheet).toHaveCount(0);
    });

    /**
     * What the cheatsheet shows beside the command that asks for suggestions
     * @param {import('@playwright/test').Page} page
     */
    async function suggestionKeys(page) {
        await openChat(page);
        await page.locator('body').click({ position: { x: 1, y: 1 } });
        await page.keyboard.press('Shift+Slash');
        const row = page.locator('.commandCheatsheet:popover-open [role=group] > div', { hasText: 'Show suggestions' });
        await expect(row).toBeVisible();
        return (await row.textContent()) ?? '';
    }

    test('suggestions are asked for on Ctrl+Space', async ({ page }) => {
        const keys = await suggestionKeys(page);
        expect(keys).toContain('Ctrl');
        expect(keys).toContain('Space');
    });

    test('suggestions are asked for on Option+Esc on a Mac, which Ctrl+Space would clash with', async ({ page }) => {
        await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' }));
        const keys = await suggestionKeys(page);
        expect(keys).toContain('⌥');
        expect(keys).toContain('Esc');
        expect(keys).not.toContain('⌃');
    });
});
