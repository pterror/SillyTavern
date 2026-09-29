export const testSetup = {
    /**
     * Navigates to the home page without waiting for SillyTavern to load.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    goST: async ({ page }) => {
        await page.goto('/');
    },

    /**
     * Waits for SillyTavern to fully load by navigating to the home page and waiting for the preloader to disappear.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    awaitST: async ({ page }) => {
        await page.goto('/');
        const origin = new URL(page.url()).origin;
        if (await testSetup.isLoginPage({ page })) {
            // eslint-disable-next-line playwright/no-networkidle
            await page.waitForLoadState('networkidle');
            // Try accounts from last to first: clicking a password-protected account stays on the login page
            const userSelects = page.locator('#userList .userSelect');
            const userCount = await userSelects.count();
            for (let i = userCount - 1; i >= 0; i--) {
                await userSelects.nth(i).click();
                const loggedIn = await page
                    .waitForURL(url => url.origin === origin && url.pathname !== '/login', { timeout: 3000 })
                    .then(() => true, () => false);
                if (loggedIn) {
                    break;
                }
            }
            if (await testSetup.isLoginPage({ page })) {
                throw new Error('Could not log into any account without a password.');
            }
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    },

    /**
     * Checks if the current page is the login page by looking for a body element with the class 'login'.
     * @param {Object} params
     * @param {import('@playwright/test').Page} params.page
     */
    isLoginPage: async ({ page }) => {
        return await page.locator('body.login').count() > 0;
    },
};

/**
 * Opens the character management drawer unless it is already open (a fresh data root starts with it closed).
 * @param {import('@playwright/test').Page} page
 */
export async function openCharacterManagementDrawer(page) {
    if (!(await page.locator('#rm_button_create').isVisible())) {
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_create').waitFor({ state: 'visible', timeout: 10000 });
    }
}

/**
 * Shows one tab of the character info panel, e.g. 'description'.
 * @param {import('@playwright/test').Page} page
 * @param {string} tab The tab's `charInfoTabs_tab` radio value.
 */
export async function openInfoTab(page, tab) {
    await page.locator(`label:has(> input[name="charInfoTabs_tab"][value="${tab}"])`).click();
}

/**
 * Turns the Stacked Drawers setting on or off through its checkbox (styled out of view in the closed User Settings
 * drawer) and waits until the change is applied and saved, so it survives a reload.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
export async function setStackedDrawers(page, on) {
    const checkbox = page.locator('#stackedDrawers');
    if (await checkbox.isChecked() === on) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes('stacked_drawers'));
    await checkbox.evaluate(el => el.click());
    await saved;
    await page.waitForFunction(expected => document.body.classList.contains('stackedDrawers') === expected, on);
}

/**
 * Sets the Drawer Bar setting through its select (in the closed User Settings drawer) and waits until the change is
 * applied and saved, so it survives a reload.
 * @param {import('@playwright/test').Page} page
 * @param {string} value 'top', 'bottom', 'left' or 'right'
 */
export async function setDrawerBarPosition(page, value) {
    const select = page.locator('#drawer_bar_position');
    if (await select.inputValue() === value) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes('drawer_bar_position'));
    await select.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await saved;
    await page.waitForFunction(v => ['bottom', 'left', 'right'].every(position => {
        const bodyClass = `drawerBar${position[0].toUpperCase()}${position.slice(1)}`;
        return document.body.classList.contains(bodyClass) === (v === position);
    }), value);
}

/**
 * Sets the Drawer Bar (Mobile) setting through its select (in the closed User Settings drawer) and waits until the
 * change is applied and saved, so it survives a reload.
 * @param {import('@playwright/test').Page} page
 * @param {string} value 'top' or 'bottom'
 */
export async function setDrawerBarMobilePosition(page, value) {
    const select = page.locator('#drawer_bar_position_mobile');
    if (await select.inputValue() === value) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes('drawer_bar_position_mobile'));
    await select.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await saved;
    await page.waitForFunction(v => document.body.classList.contains('drawerBarMobileBottom') === (v === 'bottom'), value);
}
