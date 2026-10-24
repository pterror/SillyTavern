import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Toggling a regex script in its list saves it and draws the open chat's messages again from what the page holds:
// the chat isn't opened again (no request for it, no CHAT_CHANGED) and the script list isn't drawn again.

test('toggling a regex script redraws the chat in place, not reopening it, and keeps the list as drawn', async ({ page }) => {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    const id = await page.evaluate(async () => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        await ctx.SlashCommandParser.commands['send'].callback({}, 'the cat sat');
        return ctx.chat.length - 1;
    });
    const text = page.locator(`#chat .mes[mesid="${id}"] .mes_text`);
    await expect(text).toHaveText('the cat sat');

    // A display-only script turning cat into dog, enabled through /regex-toggle (which draws the list).
    await page.evaluate(async () => {
        const { extension_settings } = await import('/scripts/extensions.js');
        extension_settings.regex.push({
            id: 'regex-toggle-redraw', scriptName: 'catdog', findRegex: '/cat/g', replaceString: 'dog', trimStrings: [],
            placement: [1, 2], disabled: true, markdownOnly: true, promptOnly: false, runOnEdit: true, substituteRegex: 0,
            minDepth: null, maxDepth: null,
        });
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/regex-toggle state=true quiet=true catdog');
    });
    await expect(text).toHaveText('the dog sat');
    const row = page.locator('#saved_regex_scripts [id="regex-toggle-redraw"]');
    await expect(row).toHaveCount(1);
    await row.evaluate(el => { el.dataset.drawnOnce = 'yes'; });

    const reopened = [];
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/chats/open') reopened.push(request.url()); });
    await page.evaluate(() => {
        window['__chatChanged'] = 0;
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        eventSource.on(eventTypes.CHAT_CHANGED, () => { window['__chatChanged']++; });
    });

    await row.locator('.disable_regex').evaluate(el => {
        /** @type {HTMLInputElement} */ (el).checked = true;
        // @ts-ignore
        $(el).trigger('input');
    });
    await expect(text).toHaveText('the cat sat');
    await page.waitForTimeout(500);
    expect(reopened).toEqual([]);
    expect(await page.evaluate(() => window['__chatChanged'])).toBe(0);
    await expect(row).toHaveAttribute('data-drawn-once', 'yes');
    expect(await page.evaluate(async () => (await import('/scripts/extensions.js')).extension_settings.regex.find(s => s.id === 'regex-toggle-redraw')?.disabled)).toBe(true);
});
