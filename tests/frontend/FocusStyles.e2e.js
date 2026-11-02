import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

test.beforeEach(testSetup.awaitST);

test('the old page\'s outlined bookmark icon draws in Font Awesome\'s regular face', async ({ page }) => {
    const icon = page.locator('#message_template .mes_bookmark_add');
    const face = await icon.evaluate(el => {
        const style = getComputedStyle(el, '::before');
        return { family: style.fontFamily, weight: style.fontWeight };
    });
    expect(face.family).toContain('Font Awesome 6 Free');
    expect(face.weight).toBe('400');
    const loaded = await page.evaluate(async () => (await document.fonts.load('400 16px "Font Awesome 6 Free"', '')).map(f => f.weight));
    expect(loaded).toEqual(['400']);
});

test('a command argument underlines under keyboard focus as under the pointer, and not while one of its parts has it', async ({ page }) => {
    await page.evaluate(() => {
        const root = document.createElement('div');
        root.className = 'autoComplete-details';
        root.id = 'focus-styles-fixture';
        root.innerHTML = '<div class="specs"><div class="body"><ul class="arguments"><li>'
            + '<span class="argument" tabindex="0">arg <span class="argument-name" tabindex="0">name</span></span>'
            + '</li></ul></div></div>';
        root.style.cssText = 'position: fixed; top: 10px; left: 10px; z-index: 100000; display: block;';
        document.body.append(root);
    });
    const argument = page.locator('#focus-styles-fixture .argument');
    const name = page.locator('#focus-styles-fixture .argument-name');
    const underline = () => argument.evaluate(el => {
        const style = getComputedStyle(el);
        return `${style.textDecorationLine} ${style.textDecorationStyle}`;
    });

    expect(await underline()).toBe('none solid');
    await argument.hover({ position: { x: 2, y: 2 } });
    expect(await underline()).toBe('underline dotted');
    await name.hover();
    expect(await underline()).toBe('none solid');
    await page.mouse.move(0, 0);

    await page.keyboard.press('Shift');
    await argument.focus();
    expect(await argument.evaluate(el => el.matches(':focus-visible'))).toBe(true);
    expect(await underline()).toBe('underline dotted');
    await name.focus();
    expect(await underline()).toBe('none solid');
});
