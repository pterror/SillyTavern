import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Covers the gallery-style character browsing view: the character list always renders as a fullscreen
 * chub.ai-style tile grid (body.charGalleryView is permanently set, not a toggle). The fullscreen layout
 * is scoped to data-active-menu="rm_characters_block" on #right-nav-panel, so it only fires when the
 * character list (browsing view) is the active sub-view - not when viewing/editing a single character.
 * No separate data path: printCharacters()'s existing /query-backed pipeline is untouched.
 */
test.describe('Character Gallery View', () => {
    test.beforeEach(testSetup.awaitST);

    test('character list renders as a fullscreen gallery grid', async ({ page }) => {
        // Gallery mode is always on - body.charGalleryView should be set even before opening the panel.
        await expect(page.locator('body')).toHaveClass(/charGalleryView/);

        // Open the character panel via the standard drawer icon.
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_characters').click();
        await expect(page.locator('#rm_print_characters_block .character_select').first()).toBeVisible();

        // Panel goes fullscreen when the character list is the active sub-view.
        const panelBox = await page.locator('#right-nav-panel').boundingBox();
        const viewport = page.viewportSize();
        expect(Math.abs(panelBox.width - viewport.width)).toBeLessThanOrEqual(2);
        expect(panelBox.x).toBeLessThanOrEqual(2);
        expect(panelBox.height).toBeGreaterThan(viewport.height * 0.8);

        // The list container is a CSS grid (chub.ai-style tiles).
        const listDisplay = await page.locator('#rm_print_characters_block').evaluate(el => getComputedStyle(el).display);
        expect(listDisplay).toBe('grid');

        // Cards lay out avatar-beside-text (row direction).
        const firstCard = page.locator('#rm_print_characters_block .character_select').first();
        const [cardFlexDirection, avatarBox, cardBox] = await Promise.all([
            firstCard.evaluate(el => getComputedStyle(el).flexDirection),
            firstCard.locator('.avatar').boundingBox(),
            firstCard.boundingBox(),
        ]);
        expect(cardFlexDirection).toBe('row');
        expect(avatarBox.width).toBeLessThan(cardBox.width * 0.5);

        // Reuses the same rendered rows.
        const firstCardAvatar = await firstCard.getAttribute('data-avatar');
        expect(firstCardAvatar).toBeTruthy();
    });
});
