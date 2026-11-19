import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function openGroupDrawer(page) {
    await page.locator('#char-info-panel').evaluate(async element => {
        await window['$'](element).promise();
        await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    });
    if (!await page.locator('#groupCurrentMemberListToggle').isVisible()) await page.locator('#charInfoDrawerIcon').click();
}
/** @param {import('@playwright/test').Page} page */
async function openMemberList(page) {
    await openGroupDrawer(page);
    if (!await page.locator('#rm_group_members').isVisible()) await page.locator('#groupCurrentMemberListToggle').click();
}
/** @param {import('@playwright/test').Page} page */
async function openCandidateList(page) {
    await openGroupDrawer(page);
    if (!await page.locator('#rm_group_filter').isVisible()) await page.locator('#groupAddMemberListToggle').click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {object} patch
 */
async function editTag(page, id, patch) {
    await page.evaluate(async ({ id, patch }) => {
        const response = await fetch('/api/tags/edit', { method: 'POST', headers: window['stTest'].context().getRequestHeaders(), body: JSON.stringify({ id, patch }) });
        if (!response.ok) throw new Error(`tag edit: ${response.status}`);
        const { onTagsChanged } = await import('/scripts/tags.js');
        onTagsChanged();
    }, { id, patch });
}

test('member pages and actions share live state with a disposable Solid popout', async ({ page }) => {
    await testSetup.awaitST({ page });
    const { id, avatars, tagId } = await page.evaluate(async () => {
        const headers = window['stTest'].context().getRequestHeaders();
        const avatars = [];
        for (let index = 0; index < 7; index++) {
            const form = new FormData();
            form.set('ch_name', `Solid member ${Date.now()} ${index}`);
            const response = await fetch('/api/characters/create', { method: 'POST', headers: window['stTest'].context().getRequestHeaders({ omitContentType: true }), body: form });
            if (!response.ok) throw new Error(`create: ${response.status}`);
            avatars.push(await response.text());
        }
        const tagId = `solid-group-tag-${Date.now()}`;
        for (const [path, body] of [
            ['/api/tags/create', { tag: { id: tagId, name: 'Member tag', folder_type: 'NONE', is_hidden_on_character_card: false } }],
            ['/api/tags/assign', { id: avatars[5], tagId }],
        ]) {
            const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!response.ok) throw new Error(`${path}: ${response.status}`);
        }
        const response = await fetch('/api/groups/create', { method: 'POST', headers, body: JSON.stringify({ name: 'Solid member pages', members: avatars }) });
        if (!response.ok) throw new Error(`group: ${response.status}`);
        const id = String((await response.json()).id);
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(id);
        return { id, avatars, tagId };
    });
    await openMemberList(page);
    const members = page.locator('#rm_group_members');
    await expect(members.locator('.group_member')).toHaveCount(5);
    await page.locator('#rm_group_members_pagination [aria-label="Next page"]').click();
    await expect(members.locator('.group_member')).toHaveCount(2);
    await expect(members.locator('.group_member').first()).toHaveAttribute('data-avatar', avatars[5]);
    await page.locator('#groupCurrentMemberPopoutButton').click();
    const popout = page.locator('#groupMemberListPopout');
    await expect(popout.locator('.group_member')).toHaveCount(2);
    const chip = popout.locator(`[id="${tagId}"]`);
    await expect(chip).toHaveText('Member tag');
    await chip.evaluate(element => { element.dataset.kept = 'yes'; });
    await editTag(page, tagId, { name: 'Renamed member tag' });
    await expect(chip).toHaveText('Renamed member tag');
    await expect(chip).toHaveAttribute('data-kept', 'yes');
    await editTag(page, tagId, { is_hidden_on_character_card: true });
    await expect(chip).toHaveCount(0);
    await expect(members.locator(`[id="${tagId}"]`)).toHaveCount(0);
    await editTag(page, tagId, { is_hidden_on_character_card: false });
    await expect(chip).toHaveText('Renamed member tag');
    await expect(members.locator(`[id="${tagId}"]`)).toHaveText('Renamed member tag');
    await popout.locator('[data-action="disable"]').first().click();
    await expect(popout.locator('.group_member').first()).toHaveClass(/disabled/);
    await expect(members.locator('.group_member').first()).toHaveClass(/disabled/);
    await popout.locator('[aria-label="Previous page"]').click();
    await expect(members.locator('.group_member')).toHaveCount(5);
    await expect(popout.locator('.group_member')).toHaveCount(5);
    await popout.locator('[data-action="down"]').first().click();
    await expect(members.locator('.group_member').first()).toHaveAttribute('data-avatar', avatars[1]);
    const removedName = await popout.locator('.group_member .ch_name').first().textContent();
    await popout.locator('[data-action="remove"]').first().click();
    await expect.poll(() => page.evaluate(async id => {
        const response = await fetch('/api/groups/batch', { method: 'POST', headers: window['stTest'].context().getRequestHeaders(), body: JSON.stringify({ ids: [id] }) });
        return (await response.json())[0].members.length;
    }, id)).toBe(6);
    await expect(members.locator(`[data-avatar="${avatars[1]}"]`)).toHaveCount(0);
    await page.locator('#groupMemberListPopoutClose').click();
    await expect(popout).toHaveCount(0);
    await openGroupDrawer(page);
    await page.locator('#groupCurrentMemberPopoutButton').click();
    await expect(page.locator('#groupMemberListPopout .group_member')).toHaveCount(5);
    await expect(page.locator('[id="rm_group_members"]')).toHaveCount(1);
    await page.locator('#groupMemberListPopoutClose').click();
    await expect(popout).toHaveCount(0);
    await openCandidateList(page);
    await page.locator('#rm_group_filter').fill(removedName);
    const candidate = page.locator(`#rm_group_add_members [data-avatar="${avatars[1]}"]`);
    await expect(candidate).toBeVisible();
    await candidate.locator('[data-action="add"]').click();
    await expect(candidate).toHaveCount(0);
    await expect(members.locator(`[data-avatar="${avatars[1]}"]`)).toHaveCount(1);
});

test('select options use the shared hover highlight even with a transparent border theme', async ({ page }) => {
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    await page.evaluate(() => document.documentElement.style.setProperty('--SmartThemeBorderColor', 'transparent'));
    const trigger = page.locator('.st-character-sort .st-select-trigger');
    await trigger.click();
    const options = page.locator('.st-select-popover:visible [role="option"]');
    const option = options.last();
    const before = await option.evaluate(element => getComputedStyle(element).backgroundColor);
    await option.hover();
    await expect.poll(() => option.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe(before);
    await expect.poll(() => option.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await trigger.press('Home');
    await expect(options.first()).toHaveAttribute('data-active', '');
    await expect.poll(() => options.first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});
