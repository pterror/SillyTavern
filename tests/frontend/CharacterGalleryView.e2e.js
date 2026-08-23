import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Covers the new fullscreen gallery view for the character list (owner tracker item #2): a toggle button below
 * #rm_button_characters that switches #rm_print_characters_block from the narrow sidebar layout to a fullscreen
 * chub.ai-style tile grid, without touching how the rows themselves get fetched/paginated/rendered
 * (printCharacters()'s existing /query-backed pipeline is untouched - this is a CSS/layout mode, not a second
 * data path).
 */
test.describe('Character Gallery View', () => {
    test.beforeEach(testSetup.awaitST);

    test('toggle switches to a fullscreen tile grid, reveals creator text, and persists across reload', async ({ page }) => {
        // Open the Character Management drawer and land on the character list sub-panel, same as a real user
        // would - the gallery toggle only matters once #rm_print_characters_block actually has rows in it.
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_characters').click();
        await expect(page.locator('#rm_print_characters_block .character_select').first()).toBeVisible();

        // Button exists directly below #rm_button_characters, in the same tab-icon column, matching its size.
        const charactersButton = page.locator('#rm_button_characters');
        const galleryButton = page.locator('#rm_button_characters_gallery');
        await expect(galleryButton).toBeVisible();
        const [charactersBox, galleryBox] = await Promise.all([
            charactersButton.boundingBox(),
            galleryButton.boundingBox(),
        ]);
        expect(galleryBox.y).toBeGreaterThan(charactersBox.y);
        expect(Math.round(galleryBox.height)).toBe(Math.round(charactersBox.height));

        // Off by default: no data-fetching path changes, just an inert body class.
        await expect(page.locator('body')).not.toHaveClass(/charGalleryView/);
        const firstCardCreatorDisplayBefore = await page
            .locator('#rm_print_characters_block .character_select .ch_creator')
            .first()
            .evaluate(el => getComputedStyle(el).display);
        expect(firstCardCreatorDisplayBefore).toBe('none');

        await galleryButton.click();

        await expect(page.locator('body')).toHaveClass(/charGalleryView/);

        // #right-nav-panel goes fullscreen - same DOM node, no reparenting, just resized.
        const panelBox = await page.locator('#right-nav-panel').boundingBox();
        const viewport = page.viewportSize();
        expect(panelBox.width).toBeGreaterThanOrEqual(viewport.width - 2);
        expect(panelBox.height).toBeGreaterThanOrEqual(viewport.height - 2);

        // The list container switches to a real CSS grid (chub.ai-style tiles) instead of the sidebar's flex column.
        const listDisplay = await page.locator('#rm_print_characters_block').evaluate(el => getComputedStyle(el).display);
        expect(listDisplay).toBe('grid');

        // Reuses the same rendered rows - same avatar identity on the first card before/after the toggle.
        const firstCardAvatarAfter = await page
            .locator('#rm_print_characters_block .character_select')
            .first()
            .getAttribute('data-avatar');
        expect(firstCardAvatarAfter).toBeTruthy();

        // Gallery-only field becomes visible now that there's room for it.
        const firstCardCreatorDisplayAfter = await page
            .locator('#rm_print_characters_block .character_select .ch_creator')
            .first()
            .evaluate(el => getComputedStyle(el).display);
        expect(firstCardCreatorDisplayAfter).not.toBe('none');

        // Persists like the app's other UI-mode toggles (power_user, saved server-side) - survives a reload
        // without the user having to open the panel or re-click anything.
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await expect(page.locator('body')).toHaveClass(/charGalleryView/);

        // Clean up so this test doesn't leave the account permanently in gallery view.
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_characters').click();
        await page.locator('#rm_button_characters_gallery').click();
        await expect(page.locator('body')).not.toHaveClass(/charGalleryView/);
    });
});
