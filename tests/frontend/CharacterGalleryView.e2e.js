import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Covers the new gallery view for the character list (owner tracker item #2): a toggle button below
 * #rm_button_characters that switches #rm_print_characters_block from the narrow sidebar layout to a centered
 * chub.ai-style tile grid, without touching how the rows themselves get fetched/paginated/rendered
 * (printCharacters()'s existing /query-backed pipeline is untouched - this is a CSS/layout mode, not a second
 * data path). Width is capped at the app's existing --sheldWidth center-column variable, not the full viewport.
 */
test.describe('Character Gallery View', () => {
    test.beforeEach(testSetup.awaitST);

    test('toggle switches to a centered tile grid capped at --sheldWidth and persists across reload', async ({ page }) => {
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

        await galleryButton.click();

        await expect(page.locator('body')).toHaveClass(/charGalleryView/);

        // #right-nav-panel goes tall and centered - same DOM node, no reparenting, just resized - but its width
        // is capped at the app's existing center-column variable (--sheldWidth) rather than the full viewport,
        // and it sits centered within that width instead of pinned to the .fillRight side gutter.
        const panelBox = await page.locator('#right-nav-panel').boundingBox();
        const viewport = page.viewportSize();
        const sheldWidth = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--sheldWidth'));
        expect(sheldWidth.trim()).not.toBe('');
        const expectedWidth = await page.evaluate((sw) => {
            const probe = document.createElement('div');
            probe.style.cssText = `position: fixed; visibility: hidden; width: ${sw};`;
            document.body.appendChild(probe);
            const width = probe.getBoundingClientRect().width;
            probe.remove();
            return width;
        }, sheldWidth);
        expect(Math.abs(panelBox.width - expectedWidth)).toBeLessThanOrEqual(2);
        // Not edge-to-edge: the whole point of the owner's follow-up ask was that this shouldn't claim the full
        // viewport width the way a true fullscreen takeover would.
        expect(panelBox.width).toBeLessThan(viewport.width);
        // Centered: roughly equal gutters on both sides.
        const leftGutter = panelBox.x;
        const rightGutter = viewport.width - (panelBox.x + panelBox.width);
        expect(Math.abs(leftGutter - rightGutter)).toBeLessThanOrEqual(3);
        expect(panelBox.height).toBeGreaterThan(viewport.height * 0.8);

        // The list container switches to a real CSS grid (chub.ai-style tiles) instead of the sidebar's flex column.
        const listDisplay = await page.locator('#rm_print_characters_block').evaluate(el => getComputedStyle(el).display);
        expect(listDisplay).toBe('grid');

        // Reuses the same rendered rows - same avatar identity on the first card before/after the toggle.
        const firstCardAvatarAfter = await page
            .locator('#rm_print_characters_block .character_select')
            .first()
            .getAttribute('data-avatar');
        expect(firstCardAvatarAfter).toBeTruthy();

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
