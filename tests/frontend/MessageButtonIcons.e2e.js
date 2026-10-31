import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test('the bookmark and swipe history buttons each show their own glyph', async ({ page }) => {
    await testSetup.awaitST({ page });
    const glyph = (selector) => page.locator(selector).first().evaluate(el => getComputedStyle(el, '::before').content);
    const [bookmark, swipes, menuBookmark, faBookmark, faLayers] = await Promise.all([
        glyph('#message_template .mes_bookmark_add'),
        glyph('#message_template .mes_swipe_picker'),
        glyph('#option_new_bookmark i'),
        page.evaluate(() => { const i = document.createElement('i'); i.className = 'fa-solid fa-bookmark'; document.body.append(i); const c = getComputedStyle(i, '::before').content; i.remove(); return c; }),
        page.evaluate(() => { const i = document.createElement('i'); i.className = 'fa-solid fa-layer-group'; document.body.append(i); const c = getComputedStyle(i, '::before').content; i.remove(); return c; }),
    ]);
    expect(faBookmark).not.toBe('none');
    expect(faLayers).not.toBe('none');
    expect(bookmark).toBe(faBookmark);
    expect(menuBookmark).toBe(faBookmark);
    expect(swipes).toBe(faLayers);
});
