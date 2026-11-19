/**
 * @param {import('@playwright/test').Page} page
 * @param {string} mode
 */
export async function chooseTagSort(page, mode) {
    const labels = { manual: 'Manual (Drag & Drop)', alphabetical: 'Alphabetical (A-Z)', by_entries: 'Most Used (By Count)' };
    await page.locator('#tag_sort_mode_select').click({ timeout: 10000 });
    await page.getByRole('option', { name: labels[mode], exact: true }).click({ timeout: 10000 });
}
