import { expect } from '@playwright/test';

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
        await awaitLoaderGone(page);
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
 * @param {import('@playwright/test').Page} page
 */
export async function awaitLoaderGone(page) {
    await page.waitForFunction('document.getElementById("loader") === null', { timeout: 0 });
}

/**
 * @param {import('@playwright/test').Page} page
 */
export async function openCharacterManagementDrawer(page) {
    if (!(await page.locator('#rm_button_create').isVisible())) {
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_create').waitFor({ state: 'visible', timeout: 10000 });
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tab
 */
export async function openInfoTab(page, tab) {
    await page.locator(`label:has(> input[name="charInfoTabs_tab"][value="${tab}"])`).click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 */
export async function awaitPowerUserSettingStored(page, key) {
    await expect.poll(() => page.evaluate(async (key) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/settings/get', { method: 'POST', headers: context.getRequestHeaders(), body: '{}' });
        const { settings } = await response.json();
        const stored = (typeof settings === 'string' ? JSON.parse(settings) : settings)?.power_user?.[key];
        return JSON.stringify(stored) === JSON.stringify(context.powerUserSettings[key]);
    }, key), { timeout: 15000 }).toBe(true);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
export async function setStackedDrawers(page, on) {
    const checkbox = page.locator('#stackedDrawers');
    if (await checkbox.isChecked() === on) return;
    await checkbox.evaluate(el => el.click());
    await awaitPowerUserSettingStored(page, 'stacked_drawers');
    await page.waitForFunction(expected => document.body.classList.contains('stackedDrawers') === expected, on);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
export async function setDrawerBarPosition(page, value) {
    const select = page.locator('#drawer_bar_position');
    if (await select.inputValue() === value) return;
    await select.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await awaitPowerUserSettingStored(page, 'drawer_bar_position');
    await page.waitForFunction(v => ['bottom', 'left', 'right'].every(position => {
        const bodyClass = `drawerBar${position[0].toUpperCase()}${position.slice(1)}`;
        return document.body.classList.contains(bodyClass) === (v === position);
    }), value);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
export async function setDrawerBarMobilePosition(page, value) {
    const select = page.locator('#drawer_bar_position_mobile');
    if (await select.inputValue() === value) return;
    await select.evaluate((el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
    await awaitPowerUserSettingStored(page, 'drawer_bar_position_mobile');
    await page.waitForFunction(v => document.body.classList.contains('drawerBarMobileBottom') === (v === 'bottom'), value);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
export async function holdCharacters(page, avatars) {
    const missing = await page.evaluate(async (avatars) => {
        const { characterRepository } = await import('/scripts/character-repository.js');
        const { holdCharacter, keepHeldCharacters } = await import('/scripts/character-store.js');
        if (!window['__testHeldAvatars']) {
            const kept = new Set();
            window['__testHeldAvatars'] = kept;
            keepHeldCharacters(() => kept);
        }
        for (const avatar of avatars) window['__testHeldAvatars'].add(avatar);
        const missing = [];
        for (const avatar of avatars) {
            const character = await characterRepository.full(avatar);
            if (character) holdCharacter(character);
            else missing.push(avatar);
        }
        return missing;
    }, avatars);
    if (missing.length > 0) throw new Error(`holdCharacters: no such characters: ${missing.join(', ')}`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string|undefined>}
 */
export async function findCharacterAvatarByName(page, name) {
    return page.evaluate(async (name) => {
        const { findCharAsync } = await import('/scripts/utils.js');
        return (await findCharAsync({ name, allowAvatar: false, insensitive: false, preferCurrentChar: false, quiet: true }))?.avatar;
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 */
export function chatBox(page) {
    return page.locator('#send_form .cm-editor .cm-content').or(page.locator('#send_textarea:not(.live-editor-textarea)'));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {string} [options.layers]
 * @param {string} [options.overlays]
 * @param {number} [options.step]
 * @returns {Promise<string[]>}
 */
export function stackMismatches(page, {
    layers = '#sheld, .drawer-content, #movingDivs > *, body > .draggable',
    overlays = '',
    step = 17,
} = {}) {
    return page.evaluate(async ({ layers, overlays, step }) => {
        const { drawerOrder } = await import('/scripts/drawer-stack.js');
        const shown = (/** @type {HTMLElement} */ el) => getComputedStyle(el).display !== 'none'
            && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const ordered = /** @type {HTMLElement[]} */ ([...document.querySelectorAll(layers)]).filter(shown)
            .sort((a, b) => drawerOrder(a) - drawerOrder(b) || Number(b.id === 'sheld') - Number(a.id === 'sheld'));
        const all = [...ordered, ...(overlays ? /** @type {HTMLElement[]} */ ([...document.querySelectorAll(overlays)]).filter(shown) : [])];
        const distance = (/** @type {HTMLElement} */ el, x, y) => {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const radius = (/** @type {string} */ value) => Math.min(parseFloat(value) || 0, r.width / 2, r.height / 2);
            const corners = [
                [radius(style.borderTopLeftRadius), r.left, r.top, 1, 1],
                [radius(style.borderTopRightRadius), r.right, r.top, -1, 1],
                [radius(style.borderBottomRightRadius), r.right, r.bottom, -1, -1],
                [radius(style.borderBottomLeftRadius), r.left, r.bottom, 1, -1],
            ];
            for (const [rad, cx, cy, dx, dy] of corners) {
                const ox = cx + dx * rad;
                const oy = cy + dy * rad;
                if (rad > 0 && (x - ox) * dx < 0 && (y - oy) * dy < 0) return Math.hypot(x - ox, y - oy) - rad;
            }
            return Math.max(r.left - x, x - r.right, r.top - y, y - r.bottom);
        };
        const inClip = (/** @type {HTMLElement} */ el, x, y) => {
            const clip = el.style.clipPath;
            if (!clip) return true;
            const r = el.getBoundingClientRect();
            const points = clip.replace(/^polygon\(evenodd,\s*/, '').replace(/\)$/, '').split(',').map(pair => pair.trim().split(/\s+/)
                .map((v, axis) => (v.endsWith('%') ? parseFloat(v) / 100 * (axis ? r.height : r.width) : parseFloat(v))));
            const [px, py] = [x - r.left, y - r.top];
            let inside = false;
            for (let a = 0, b = points.length - 1; a < points.length; b = a++) {
                const [ax, ay] = points[a];
                const [bx, by] = points[b];
                if ((ay > py) !== (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;
            }
            return inside;
        };
        const modal = document.querySelector('dialog:modal');
        const inTopLayer = (/** @type {HTMLElement} */ el) => el.matches('dialog, [popover]');
        const blockers = [...all, document.getElementById('top-bar'), document.getElementById('top-settings-holder')].filter(Boolean);
        const out = [];
        for (const [i, layer] of all.entries()) {
            const above = all.slice(i + 1).filter(other => !other.contains(layer) && (!layer.contains(other) || inTopLayer(other)));
            const saved = blockers.map(el => el.style.pointerEvents);
            blockers.forEach(el => { if (el !== layer && !el.contains(layer)) el.style.pointerEvents = 'none'; });
            layer.style.pointerEvents = 'auto';
            for (let x = 3; x < innerWidth; x += step) {
                for (let y = 3; y < innerHeight; y += step) {
                    const own = distance(layer, x, y);
                    if (own > -2 || above.some(other => Math.abs(distance(other, x, y)) < 2)) continue;
                    const covered = above.some(other => distance(other, x, y) < 0);
                    const shows = modal && !modal.contains(layer)
                        ? !layer.classList.contains('stackCovered') && inClip(layer, x, y)
                        : layer.contains(document.elementFromPoint(x, y));
                    if (shows === covered) out.push(`${x},${y}: ${layer.id || layer.className} ${shows ? 'shows under a cover' : 'cut where uncovered'}`);
                }
            }
            blockers.forEach((el, j) => { el.style.pointerEvents = saved[j]; });
        }
        return out;
    }, { layers, overlays, step });
}
