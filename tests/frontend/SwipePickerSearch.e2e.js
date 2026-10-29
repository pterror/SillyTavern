import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The swipe picker shows a message's swipes a page at a time, and a search narrows them to those holding every word
// typed; the swipe Go jumps to is always one in view.

test('the swipe picker pages a message\'s swipes, searches them, and Go jumps to the match', async ({ page }) => {
    test.setTimeout(120000);
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    // 60 swipes in all: every tenth added one mentions a lighthouse, one of them a red one.
    await page.evaluate(async () => {
        // @ts-ignore
        const commands = SillyTavern.getContext().SlashCommandParser.commands;
        for (let i = 1; i < 60; i++) {
            const extra = i === 30 ? ' A red Lighthouse.' : i % 10 === 0 ? ' A lighthouse.' : '';
            await commands['addswipe'].callback({ quiet: 'true' }, `Alternative ${i}.${extra}`);
        }
    });
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().chat[0].swipes.length)).toBe(60);

    await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
    const popup = page.locator('.swipe_picker_popup');
    const blocks = popup.locator('.swipe_picker_block');
    await expect(blocks).toHaveCount(50);
    await expect(popup.locator('.swipe_picker_page')).toHaveText('Page 1 of 2');
    await popup.locator('.swipe_picker_next').click();
    await expect(blocks).toHaveCount(10);
    await expect(popup.locator('.swipe_picker_page')).toHaveText('Page 2 of 2');

    await popup.locator('.swipe_picker_search').fill('lighthouse');
    await expect(blocks).toHaveCount(5);
    await expect(popup.locator('.swipe_picker_pager')).toBeHidden();
    await popup.locator('.swipe_picker_search').fill('red LIGHTHOUSE');
    await expect(blocks).toHaveCount(1);
    await expect(blocks.first()).toHaveAttribute('data-swipe-id', '30');
    // The selected swipe was hidden by the search: the match is selected instead.
    await expect(blocks.first()).toHaveAttribute('highlight', 'true');
    await popup.locator('.swipe_picker_search').fill('no such words');
    await expect(blocks).toHaveCount(0);
    await expect(popup).toContainText('No swipe has that text.');

    // A swipe asked for by number is shown, the search that hid it cleared.
    await popup.locator('input[type="number"]').fill('57');
    await expect(popup.locator('.swipe_picker_search')).toHaveValue('');
    await expect(popup.locator('.swipe_picker_page')).toHaveText('Page 2 of 2');
    await expect(popup.locator('.swipe_picker_block[data-swipe-id="56"]')).toHaveAttribute('highlight', 'true');

    await popup.locator('.swipe_picker_search').fill('red lighthouse');
    await popup.locator('.popup-button-ok').click();
    await expect(popup).toBeHidden();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().chat[0].swipe_id)).toBe(30);
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText('A red Lighthouse.');
});

// Opening the picker fetches only the page it shows (a character can have thousands of greetings: fetching every
// one froze the page on a phone); the first search fetches the rest once, and typing doesn't redo work per key.
test('opening the swipe picker fetches the shown page only; a search fetches the rest once', async ({ page }) => {
    test.setTimeout(180000);
    await testSetup.awaitST({ page });
    const name = `ManyGreetings-${Date.now()}`;
    const avatar = await page.evaluate(async (name) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Greeting 0.');
        for (let i = 1; i < 200; i++) form.append('alternate_greetings', `Greeting ${i}.${i === 150 ? ' A lighthouse.' : ''}`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    }, name);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#chat .mes[mesid="0"] .swipes-counter')).toContainText('/200', { timeout: 15000 });

    /** @type {number[]} */
    const limits = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/chats/openings') limits.push(Number(request.postDataJSON()?.limit ?? 0));
    });
    // The dialog opens before the page's texts arrive (they're held back here), its rows saying they're loading.
    /** @type {(() => void) | null} */
    let release = null;
    const held = new Promise(resolve => { release = () => resolve(undefined); });
    await page.route('**/api/chats/openings', async route => { await held; await route.continue(); });
    await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
    const popup = page.locator('.swipe_picker_popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.swipe_picker_block').nth(49)).toContainText('Loading…');
    // @ts-ignore
    release();
    await expect(popup.locator('.swipe_picker_block')).toHaveCount(50);
    await expect(popup.locator('.swipe_picker_block').nth(49)).toContainText('Greeting 49.');
    expect(Math.max(0, ...limits)).toBeLessThanOrEqual(51);

    await popup.locator('.swipe_picker_search').pressSequentially('lighthouse');
    await expect(popup.locator('.swipe_picker_block')).toHaveCount(1);
    await expect(popup.locator('.swipe_picker_block')).toContainText('Greeting 150.');
    expect(limits.filter(limit => limit > 51)).toHaveLength(1);
});
