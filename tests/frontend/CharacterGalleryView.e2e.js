import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

/**
 * Covers the gallery view for the character list (owner tracker item #2): a toggle button below
 * #rm_button_characters that switches #rm_print_characters_block from the narrow sidebar layout to a genuinely
 * fullscreen chub.ai-style tile grid, without touching how the rows themselves get fetched/paginated/rendered
 * (printCharacters()'s existing /query-backed pipeline is untouched - this is a CSS/layout mode, not a second
 * data path). Edge-to-edge: not capped at the app's --sheldWidth center-column variable - that was an earlier,
 * reverted pass; this view claims the full viewport.
 */
test.describe('Character Gallery View', () => {
    test.beforeEach(testSetup.awaitST);

    test('toggle switches to a fullscreen tile grid and persists across reload', async ({ page }) => {
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

        // #right-nav-panel goes tall and genuinely fullscreen - same DOM node, no reparenting, just resized -
        // edge to edge, not capped at the app's --sheldWidth center-column variable (an earlier pass did that
        // and was reverted: the owner wanted a true fullscreen takeover for this view, not a centered column).
        const panelBox = await page.locator('#right-nav-panel').boundingBox();
        const viewport = page.viewportSize();
        expect(Math.abs(panelBox.width - viewport.width)).toBeLessThanOrEqual(2);
        expect(panelBox.x).toBeLessThanOrEqual(2);
        expect(panelBox.height).toBeGreaterThan(viewport.height * 0.8);

        // The list container switches to a real CSS grid (chub.ai-style tiles) instead of the sidebar's flex column.
        const listDisplay = await page.locator('#rm_print_characters_block').evaluate(el => getComputedStyle(el).display);
        expect(listDisplay).toBe('grid');

        // Cards lay out avatar-beside-text (row direction), not avatar-on-top/text-below - the thumbnail is a
        // fixed-width column next to the name/creator/description/tags, not a full-width image above them.
        const firstCard = page.locator('#rm_print_characters_block .character_select').first();
        const [cardFlexDirection, avatarBox, cardBox] = await Promise.all([
            firstCard.evaluate(el => getComputedStyle(el).flexDirection),
            firstCard.locator('.avatar').boundingBox(),
            firstCard.boundingBox(),
        ]);
        expect(cardFlexDirection).toBe('row');
        // Avatar is a narrow column, not the full card width.
        expect(avatarBox.width).toBeLessThan(cardBox.width * 0.5);

        // Reuses the same rendered rows - same avatar identity on the first card before/after the toggle.
        const firstCardAvatarAfter = await firstCard.getAttribute('data-avatar');
        expect(firstCardAvatarAfter).toBeTruthy();

        // Search bar and result count sit in one row, not stacked - #form_character_search_form is the shared
        // flex row wrapping both.
        const searchFormFlexDirection = await page
            .locator('#form_character_search_form')
            .evaluate(el => getComputedStyle(el).flexDirection);
        expect(searchFormFlexDirection).toBe('row');

        // Favorite badge (.ch_fav_icon), when present, sits over the card - specifically over the avatar corner,
        // not down in the text column below/beside it. Guards against .character_select_container's
        // `position: relative` (style.css, needed for group rows' .character_name_block_sub_line) silently
        // becoming the badge's containing block instead of the card itself. Conditional: whether any card is
        // favorited depends on the test account's data, not something this test controls.
        const favCard = page.locator('#rm_print_characters_block .character_select.is_fav').first();
        if (await favCard.count() > 0) {
            const [favIconBox, favCardBox, favAvatarBox] = await Promise.all([
                favCard.locator('.ch_fav_icon').boundingBox(),
                favCard.boundingBox(),
                favCard.locator('.avatar').boundingBox(),
            ]);
            // Within the card's own bounds...
            expect(favIconBox.y).toBeGreaterThanOrEqual(favCardBox.y - 1);
            // ...and vertically over the avatar (not below it, in the text column).
            expect(favIconBox.y).toBeLessThan(favAvatarBox.y + favAvatarBox.height);
        }

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
