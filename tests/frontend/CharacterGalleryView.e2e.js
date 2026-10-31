import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

test.describe('Character Gallery View', () => {
    test.beforeEach(testSetup.awaitST);

    test('character list renders as a fullscreen gallery grid', async ({ page }) => {
        await expect(page.locator('body')).toHaveClass(/charGalleryView/);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#rm_print_characters_block .character_select').first()).toBeVisible();

        const viewport = page.viewportSize();
        await expect.poll(async () => (await page.locator('#right-nav-panel').boundingBox()).height).toBeGreaterThan(viewport.height * 0.8);
        const panelBox = await page.locator('#right-nav-panel').boundingBox();
        expect(Math.abs(panelBox.width - viewport.width)).toBeLessThanOrEqual(2);
        expect(panelBox.x).toBeLessThanOrEqual(2);
        expect(panelBox.height).toBeGreaterThan(viewport.height * 0.8);

        const listDisplay = await page.locator('#rm_print_characters_block').evaluate(el => getComputedStyle(el).display);
        expect(listDisplay).toBe('grid');

        const firstCard = page.locator('#rm_print_characters_block .character_select').first();
        const [cardFlexDirection, avatarBox, cardBox] = await Promise.all([
            firstCard.evaluate(el => getComputedStyle(el).flexDirection),
            firstCard.locator('.avatar').boundingBox(),
            firstCard.boundingBox(),
        ]);
        expect(cardFlexDirection).toBe('row');
        expect(avatarBox.width).toBeLessThan(cardBox.width * 0.5);

        await expect(firstCard).toHaveAttribute('data-avatar', /.+/);
    });

    test('a favorite\'s star sits inside its card, clear of the border and the avatar', async ({ page }) => {
        await openCharacterManagementDrawer(page);
        const card = page.locator('#rm_print_characters_block .character_select').first();
        await expect(card).toBeVisible();
        await card.evaluate(el => el.classList.add('is_fav'));
        const [cardBox, starBox, avatarBox] = await Promise.all([
            card.boundingBox(),
            card.locator('.ch_fav_icon').boundingBox(),
            card.locator('.avatar').boundingBox(),
        ]);
        expect(starBox.x + starBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width - 9);
        expect(starBox.y).toBeGreaterThanOrEqual(cardBox.y + 9);
        expect(starBox.x).toBeGreaterThan(avatarBox.x + avatarBox.width);
    });

    test('a search with few results keeps its cards their own height', async ({ page }) => {
        await openCharacterManagementDrawer(page);
        const cards = page.locator('#rm_print_characters_block .character_select');
        await expect(cards.first()).toBeVisible();
        const search = page.locator('#character_search_bar');
        if (!await search.isVisible()) await page.locator('#rm_button_search').click();
        await search.fill('Seraphina');
        await expect(cards).toHaveCount(1);
        const listHeight = (await page.locator('#rm_print_characters_block').boundingBox()).height;
        const cardHeight = (await cards.first().boundingBox()).height;
        expect(cardHeight).toBeLessThan(listHeight / 2);
    });
});
