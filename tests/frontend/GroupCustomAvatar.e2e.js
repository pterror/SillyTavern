import path from 'node:path';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

const IMAGE = path.join(process.cwd(), '..', 'default', 'content', 'user-default.png');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
function storedAvatarUrl(page, id) {
    return page.evaluate(async (id) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const response = await fetch('/api/groups/batch', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ids: [id], fields: ['avatar_url'] }) });
        return response.ok ? (await response.json())[0]?.avatar_url ?? '' : `status ${response.status}`;
    }, id);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function openGroupEditor(page, id) {
    await page.evaluate(async (id) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const { groupsStore, openGroupById } = await import('/scripts/group-chats.js');
        await ctx.getCharacters({ silentGroups: true });
        groupsStore.reportCreated(id);
        await openGroupById(id);
    }, id);
    if (!(await page.locator('#group_avatar_preview').isVisible())) await page.locator('#charInfoDrawerIcon').click();
    await expect(page.locator('#group_avatar_preview')).toBeVisible();
}

test('a group\'s own image is stored and shown, and restoring brings the collage back', async ({ page }) => {
    await testSetup.awaitST({ page });
    const id = await page.evaluate(async () => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const { power_user } = await import('/scripts/power-user.js');
        power_user.never_resize_avatars = true;
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name: `Avatar group ${Date.now()}`, members: ['default_Seraphina.png'] }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        return String((await response.json()).id);
    });
    await openGroupEditor(page, id);
    await expect(page.locator('#group_avatar_preview .collage_1')).toHaveCount(1);
    await expect(page.locator('#rm_group_restore_avatar')).toBeHidden();

    await page.locator('#group_avatar_button').setInputFiles(IMAGE);
    await expect.poll(() => storedAvatarUrl(page, id)).toMatch(/\.jpg/);
    const url = await storedAvatarUrl(page, id);
    await expect(page.locator('#group_avatar_preview img').first()).toHaveAttribute('src', url);
    await expect(page.locator('#rm_group_restore_avatar')).toBeVisible();

    await page.reload();
    await testSetup.awaitST({ page });
    await openGroupEditor(page, id);
    await expect(page.locator('#group_avatar_preview img').first()).toHaveAttribute('src', url);
    await expect(page.locator(`#rm_print_characters_block .group_select[data-grid="${id}"] img`).first()).toHaveAttribute('src', url);

    await page.locator('#rm_group_restore_avatar').click();
    await page.locator('.popup-button-ok').click();
    await expect.poll(() => storedAvatarUrl(page, id)).toBe('');
    await expect(page.locator('#group_avatar_preview img').first()).not.toHaveAttribute('src', url);
    await expect(page.locator('#rm_group_restore_avatar')).toBeHidden();
});
