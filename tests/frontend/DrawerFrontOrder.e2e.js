import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers, findCharacterAvatarByName, chatBox } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Clicks a control (through its own handler; it may be styled out of view) and waits until the server has saved
 * the given power_user key.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @param {() => Promise<void>} change
 */
async function changeAndAwaitSave(page, key, change) {
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes(key));
    await change();
    await saved;
}

/**
 * Puts back the power_user defaults these tests change. The data root is shared by the worker's later tests, which
 * expect the defaults: fullscreen character info left saved, for one, covers the chat whenever a character is opened.
 * Pins live in this browser's storage, which each test starts fresh, so they need nothing.
 * @param {import('@playwright/test').Page} page
 */
async function restoreDrawerDefaults(page) {
    for (const { panel, cls, toggle, key, on } of [
        { panel: '#char-info-panel', cls: 'charInfoFullscreen', toggle: '#charInfoFullscreenToggle', key: 'charInfoFullscreen', on: false },
        { panel: '#right-nav-panel', cls: 'galleryFullscreen', toggle: '#galleryFullscreenToggle', key: 'charGalleryFullscreen', on: true },
    ]) {
        if (await page.locator(panel).evaluate((el, c) => el.classList.contains(c), cls) !== on) {
            await changeAndAwaitSave(page, key, () => page.locator(toggle).evaluate(el => el.click()));
        }
    }
    if (Number(await page.locator('#chat_width_max').inputValue()) !== 120) {
        await changeAndAwaitSave(page, 'chat_width_max', () => setSettingInput(page, '#chat_width_max', 120));
    }
    if (Number(await page.locator('#chat_width_slider').inputValue()) !== 50) {
        await changeAndAwaitSave(page, 'chat_width', () => dragChatWidthSlider(page, 50));
    }
    await setStackedDrawers(page, false);
}

test.afterEach(async ({ page }) => restoreDrawerDefaults(page));

// Pins are toggled through the checkbox's own click handler; the checkbox itself is styled out of view.
async function setPin(page, pinId, pinned) {
    const pin = page.locator(pinId);
    if (await pin.isChecked() !== pinned) {
        await pin.evaluate(el => el.click());
    }
}

/**
 * Leaves the page on a fresh character's chat holding one message from that character (so it has a
 * clickable .mes .avatar), with every drawer closed.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} The character's name.
 */
async function openChatWithCharacterMessage(page) {
    const name = `DrawerFrontOrder-${Date.now()}`;
    await page.locator('#rightNavDrawerIcon').click();
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').evaluate(el => el.click());
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.waitForFunction(n => window['SillyTavern'].getContext().name2 === n, name);
    // Fullscreen character management still covers the chat behind character info: close it. Its icon brings it
    // forward first while character info covers part of it, and closes it on the next click.
    await expect(async () => {
        if (await page.locator('#right-nav-panel').evaluate(el => el.classList.contains('openDrawer'))) {
            await page.locator('#rightNavDrawerIcon').click();
        }
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/, { timeout: 1000 });
    }).toPass();
    await chatBox(page).fill(`/sendas name="${name}" hello`);
    // Enter can go unhandled while the freshly selected chat loads; the text stays in the box until it is sent.
    await expect(async () => {
        if (await page.locator('#send_textarea').inputValue()) {
            await chatBox(page).press('Enter');
        }
        await expect(page.locator('#chat .mes .avatar').first()).toBeVisible({ timeout: 2000 });
    }).toPass();
    // A click on the chat closes every unpinned drawer.
    await page.locator('#chat').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('#right-nav-panel')).toBeHidden();
    await expect(page.locator('#char-info-panel')).toBeHidden();
    return name;
}

test.describe('Drawer front order', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await setStackedDrawers(page, true);
    });

    test('a zoomed avatar opened with character info in front of character management is on top', async ({ page }) => {
        // In the sidebar: fullscreen character management would cover the chat, avatar included.
        await setFullscreen(page, { id: 'right-nav-panel', fullscreen: false });
        await openChatWithCharacterMessage(page);
        // Both pinned, so the avatar click below doesn't just close them; character management in front.
        await page.locator('#charInfoDrawerIcon').click();
        await setPin(page, '#charInfo_button_panel_pin', true);
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await expectStackCut(page, 'after bringing character management forward', 'right-nav-panel');

        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        // Fullscreen character management behind it shows only where character info doesn't cover it.
        await expectStackCut(page, 'after bringing character info forward', 'char-info-panel');

        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
        // The zoomed avatar came last, so it is on top: what it covers of the drawers is cut away.
        await expect.poll(() => page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img').evaluate(el => {
            const r = el.getBoundingClientRect();
            return document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
                .some(hit => hit.closest('#top-settings-holder')) === false;
        })).toBe(true);
        await expectStackCut(page, 'after zooming the avatar', 'char-info-panel');
    });

    test('closing character management uncovers the zoomed avatar', async ({ page }) => {
        await openChatWithCharacterMessage(page);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
    });

    test('character management comes back in one click after switching character', async ({ page }) => {
        const name = await openChatWithCharacterMessage(page);
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('.character_select', { hasText: name }).first().click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expectStackCut(page, 'after selecting a character', 'char-info-panel');

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await expectStackCut(page, 'after clicking the character management icon', 'right-nav-panel');
    });

    test('API connections opened over pinned fullscreen character management is on top', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();

        await page.locator('#API-status-top').click();
        const apiBlock = page.locator('#rm_api_block');
        await expect(apiBlock).toBeVisible();
        // Fullscreen character management shows only around it.
        await expectStackCut(page, 'after opening API Connections', 'rm_api_block');
        // Visible alone doesn't mean on top: the element under the drawer's center must be the drawer's own.
        await expect.poll(() => apiBlock.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        })).toBe(true);
    });

    test('pinned character management stays open after reload and one click closes it', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel')).toBeVisible();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#right-nav-panel')).toBeVisible();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
    });

    test('pinned character info opened by selecting a character stays open after reload', async ({ page }) => {
        const name = await openChatWithCharacterMessage(page);
        await page.locator('#charInfoDrawerIcon').click();
        await setPin(page, '#charInfo_button_panel_pin', true);
        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('.character_select', { hasText: name }).first().click();
        await expect(page.locator('#char-info-panel')).toBeVisible();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#char-info-panel')).toBeVisible();
    });

    test('pinned character management closed before reload stays closed', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });
});

// Every drawer in #top-settings-holder, by its .drawer-content id. The four with a pin are the pinnable panels;
// the two with a fullscreen toggle can each be drawn in the sidebar or fullscreen.
const TOP_DRAWERS = {
    'left-nav-panel': { name: 'AI Response Configuration', pin: '#lm_button_panel_pin' },
    'rm_api_block': { name: 'API Connections' },
    'AdvancedFormatting': { name: 'AI Response Formatting' },
    'WorldInfo': { name: 'World Info', pin: '#WI_panel_pin' },
    'user-settings-block': { name: 'User Settings' },
    'Backgrounds': { name: 'Backgrounds' },
    'rm_extensions_block': { name: 'Extensions' },
    'PersonaManagement': { name: 'Persona Management' },
    'right-nav-panel': { name: 'Character Management', pin: '#rm_button_panel_pin', fullscreenToggle: '#galleryFullscreenToggle', fullscreenClass: 'galleryFullscreen' },
    'char-info-panel': { name: 'Character Info', pin: '#charInfo_button_panel_pin', fullscreenToggle: '#charInfoFullscreenToggle', fullscreenClass: 'charInfoFullscreen' },
};
const PINNABLE_IDS = Object.keys(TOP_DRAWERS).filter(id => TOP_DRAWERS[id].pin);
const FILL_RIGHT_IDS = ['right-nav-panel', 'char-info-panel'];

/**
 * One way a drawer can be shown: which drawer, and for the two fullscreen-capable ones whether fullscreen is on.
 * @typedef {{ id: string, fullscreen?: boolean }} DrawerVariant
 */

/** @param {DrawerVariant} variant */
function variantLabel(variant) {
    const { name } = TOP_DRAWERS[variant.id];
    if (variant.fullscreen === undefined) return name;
    return `${variant.fullscreen ? 'fullscreen' : 'sidebar'} ${name}`;
}

/** @param {string} id @returns {DrawerVariant[]} */
function variantsOf(id) {
    return TOP_DRAWERS[id].fullscreenToggle ? [{ id, fullscreen: false }, { id, fullscreen: true }] : [{ id }];
}

/**
 * The icon that opens, fronts or closes a top-bar drawer.
 * @param {import('@playwright/test').Page} page
 * @param {string} id The .drawer-content id.
 */
function drawerIcon(page, id) {
    return page.locator('#top-settings-holder > .drawer').filter({ has: page.locator(`#${id}`) }).locator('> .drawer-toggle .drawer-icon');
}

/**
 * Which top-bar drawers are open and actually visible, and every pair of visible ones whose boxes overlap.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ open: string[], visible: string[], overlaps: string[], stack: string[] }>}
 */
function drawerOverlapState(page) {
    return page.evaluate(() => {
        const open = Array.from(document.querySelectorAll('#top-settings-holder > .drawer > .drawer-content.openDrawer'));
        const visible = open.filter(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        });
        const overlaps = [];
        for (let i = 0; i < visible.length; i++) {
            for (let j = i + 1; j < visible.length; j++) {
                const a = visible[i].getBoundingClientRect();
                const b = visible[j].getBoundingClientRect();
                const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                if (width > 1 && height > 1) overlaps.push(`${visible[i].id} + ${visible[j].id}`);
            }
        }
        // Which drawer is in front and which are cut changes when an icon brings a partly covered drawer forward.
        const stack = open.map(el => `${el.id}:${el.style.getPropertyValue('--drawerOrder')}:${el.dataset.stackCut ?? ''}`);
        return { open: open.map(el => el.id), visible: visible.map(el => el.id), overlaps, stack };
    });
}

/**
 * What the user sees of the stacked layers (stacked drawers on): every layer on screen (the chat, the shown top-bar
 * drawers, floating windows, open lists), bottom first, and every sample point where a layer can be hit
 * (`elementsFromPoint` follows clip paths and visibility) although a layer above covers that point, or can't be hit
 * although nothing above covers it.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ layers: string[], cutWrong: string[], frontmost: string | null }>}
 */
function stackState(page) {
    return page.evaluate(() => {
        const shown = el => el.isConnected && getComputedStyle(el).display !== 'none'
            && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
        const order = el => Number(el.style.getPropertyValue('--drawerOrder')) || 0;
        const ordered = [...document.querySelectorAll('#sheld, #top-settings-holder > .drawer > .drawer-content, #movingDivs > *, body > .draggable')]
            .filter(shown)
            .sort((a, b) => order(a) - order(b)
                || Number(b.id === 'sheld') - Number(a.id === 'sheld')
                || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        const lists = [...document.querySelectorAll('.ui-menu, .select2-container--open > .select2-dropdown')].filter(shown);
        const layers = [...ordered, ...lists];
        const name = el => el.id || String(el.className).split(' ')[0] || el.tagName;
        const cutWrong = [];
        layers.forEach((layer, i) => {
            const box = layer.getBoundingClientRect();
            const above = layers.slice(i + 1).filter(a => !layer.contains(a)).map(a => a.getBoundingClientRect());
            // Rounded corners aren't hit, so samples stay clear of them.
            const inset = Math.max(3, ...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius']
                .map(k => parseFloat(getComputedStyle(layer)[k]) || 0)) + 2;
            if (box.width <= 2 * inset || box.height <= 2 * inset) return;
            for (let gx = 0; gx < 7; gx++) {
                for (let gy = 0; gy < 7; gy++) {
                    const x = box.left + inset + (box.width - 2 * inset) * gx / 6;
                    const y = box.top + inset + (box.height - 2 * inset) * gy / 6;
                    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
                    // Too close to an edge above to judge: sub-pixel rounding.
                    if (above.some(a => Math.min(Math.abs(x - a.left), Math.abs(x - a.right), Math.abs(y - a.top), Math.abs(y - a.bottom)) < 2)) continue;
                    const covered = above.some(a => x > a.left && x < a.right && y > a.top && y < a.bottom);
                    const hit = document.elementsFromPoint(x, y).some(el => layer.contains(el));
                    if (hit === covered) cutWrong.push(`${name(layer)} ${covered ? 'shows under a layer above' : 'is cut where nothing covers it'} at ${Math.round(x)},${Math.round(y)} (hit: ${document.elementsFromPoint(x, y).slice(0, 3).map(name).join(' > ')})`);
                }
            }
        });
        const drawers = ordered.filter(el => el.matches('.drawer-content'));
        return { layers: layers.map(name), cutWrong: cutWrong.slice(0, 5), frontmost: drawers.length ? drawers[drawers.length - 1].id : null };
    });
}

/**
 * Soft-asserts what the user sees after an action: `frontId` is the top drawer and nothing covers any of it, each
 * layer is cut exactly where a layer above covers it and visible everywhere else, and records what was seen.
 * @param {import('@playwright/test').Page} page
 * @param {string} step What the check is after, for the record.
 * @param {string} frontId The drawer the last action put in front.
 * @param {string[]} [alsoVisible] Drawers that must stay at least partly visible beside it.
 */
async function expectStackCut(page, step, frontId, alsoVisible = []) {
    // Drawers settle over several frames after an action; judging a passing moment mid-way could miss a wrong cut that
    // shows up once they have settled.
    let previous;
    await expect.poll(async () => {
        const current = JSON.stringify(await stackState(page)) + JSON.stringify(await drawerOverlapState(page));
        const settled = current === previous;
        previous = current;
        return settled;
    }, { intervals: [300] }).toBe(true);
    const summarize = async () => {
        const stack = await stackState(page);
        const { visible } = await drawerOverlapState(page);
        const frontCut = await page.locator(`#${frontId}`).evaluate(el => el.dataset.stackCut === 'true' || !el.checkVisibility({ visibilityProperty: true }));
        return {
            frontmost: stack.frontmost,
            frontCut,
            cutWrong: stack.cutWrong,
            hiddenButRequired: alsoVisible.filter(id => !visible.includes(id)),
        };
    };
    await expect.configure({ soft: true }).poll(summarize, { message: step })
        .toEqual({ frontmost: frontId, frontCut: false, cutWrong: [], hiddenButRequired: [] });
    test.info().annotations.push({ type: 'observed', description: `${step}: ${JSON.stringify(await stackState(page))}` });
}

/**
 * Waits until the open/visible drawer set changes after an action.
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} action
 */
async function actAndSettle(page, action) {
    const before = JSON.stringify(await drawerOverlapState(page));
    await action();
    await expect.poll(async () => JSON.stringify(await drawerOverlapState(page))).not.toBe(before);
}

/**
 * Unpins the four pinnable panels and closes every top-bar drawer.
 * @param {import('@playwright/test').Page} page
 */
async function resetDrawers(page) {
    for (const id of PINNABLE_IDS) {
        await setPin(page, TOP_DRAWERS[id].pin, false);
    }
    for (let i = 0; i < 30; i++) {
        const { open } = await drawerOverlapState(page);
        if (!open.length) return;
        // An open drawer hidden behind another one comes forward on the first click and closes on the next.
        await actAndSettle(page, () => drawerIcon(page, open[0]).click());
    }
    throw new Error('Could not close every drawer');
}

/**
 * Sets whether a fullscreen-capable panel is fullscreen, through its own toggle. Leaves every drawer closed.
 * @param {import('@playwright/test').Page} page
 * @param {DrawerVariant} variant
 */
async function setFullscreen(page, variant) {
    const { fullscreenToggle, fullscreenClass } = TOP_DRAWERS[variant.id];
    if (variant.fullscreen === undefined) return;
    const panel = page.locator(`#${variant.id}`);
    if (await panel.evaluate((el, cls) => el.classList.contains(cls), fullscreenClass) === variant.fullscreen) return;
    await actAndSettle(page, () => drawerIcon(page, variant.id).click());
    await page.locator(fullscreenToggle).evaluate(el => el.click());
    await expect.poll(() => panel.evaluate((el, cls) => el.classList.contains(cls), fullscreenClass)).toBe(variant.fullscreen);
    await actAndSettle(page, () => drawerIcon(page, variant.id).click());
    await expect(panel).toHaveClass(/closedDrawer/);
}

/**
 * Opens a top-bar drawer by its icon and waits for it to be open.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function openDrawer(page, id) {
    await drawerIcon(page, id).click();
    await expect(page.locator(`#${id}`)).toHaveClass(/openDrawer/);
}

/**
 * Starts a scenario: every drawer closed, both fullscreen-capable panels in the given (or current) mode, the
 * given drawers pinned and every other one unpinned.
 * @param {import('@playwright/test').Page} page
 * @param {{ variants: DrawerVariant[], pinned: string[] }} setup
 */
async function startScenario(page, { variants, pinned }) {
    await resetDrawers(page);
    for (const variant of variants) {
        await setFullscreen(page, variant);
    }
    for (const id of pinned) {
        await setPin(page, TOP_DRAWERS[id].pin, true);
    }
}

/**
 * Makes a character through the create form and returns its avatar key. Leaves every drawer closed.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function createCharacter(page) {
    const name = `DrawerOverlap-${Date.now()}`;
    // With no character selected, character info opens on the create form.
    await openDrawer(page, 'char-info-panel');
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').evaluate(el => el.click());
    const findAvatar = () => findCharacterAvatarByName(page, name);
    await expect.poll(findAvatar).not.toBeUndefined();
    const avatar = await findAvatar();
    await resetDrawers(page);
    return avatar;
}

/**
 * Every pairing of pinned panel A with another drawer B: B's variant and, if B is pinnable, whether it is pinned.
 * @param {DrawerVariant} a
 * @returns {{ b: DrawerVariant, bPinned: boolean }[]}
 */
function partnersOf(a) {
    const partners = [];
    for (const id of Object.keys(TOP_DRAWERS)) {
        if (id === a.id) continue;
        for (const b of variantsOf(id)) {
            for (const bPinned of TOP_DRAWERS[id].pin ? [false, true] : [false]) {
                partners.push({ b, bPinned });
            }
        }
    }
    return partners;
}

/** @param {DrawerVariant} b @param {boolean} bPinned */
function partnerLabel(b, bPinned) {
    return TOP_DRAWERS[b.id].pin ? `${bPinned ? 'pinned' : 'unpinned'} ${variantLabel(b)}` : variantLabel(b);
}

/**
 * Registers the drawer pair tests for one layout.
 * @param {string} layout
 */
function drawerPairTests(layout) {
    // Pinned A open, then B opened (the sweep path), then A's icon clicked while A is hidden behind B.
    for (const id of PINNABLE_IDS) {
        for (const a of variantsOf(id)) {
            for (const { b, bPinned } of partnersOf(a)) {
                test(`${layout}: pinned ${variantLabel(a)}, then ${partnerLabel(b, bPinned)} opened, then ${TOP_DRAWERS[a.id].name} brought forward`, async ({ page }) => {
                    await startScenario(page, { variants: [a, b], pinned: [a.id, ...(bPinned ? [b.id] : [])] });
                    await openDrawer(page, a.id);
                    await openDrawer(page, b.id);
                    await expectStackCut(page, `after opening ${b.id}`, b.id);

                    const { open } = await drawerOverlapState(page);
                    const covered = await page.locator(`#${a.id}`).evaluate(el => el.dataset.stackCut === 'true');
                    if (!open.includes(a.id) || !covered) {
                        test.info().annotations.push({ type: 'observed', description: `${a.id} not open and covered after opening ${b.id}; icon click would close it rather than bring it forward, step skipped` });
                        return;
                    }
                    await drawerIcon(page, a.id).click();
                    await expectStackCut(page, `after clicking ${a.id}'s icon`, a.id);
                });
            }
        }
    }

    // Pinned sidebar A open, B opened, then A's fullscreen toggle clicked.
    for (const id of FILL_RIGHT_IDS) {
        const a = { id, fullscreen: false };
        for (const { b, bPinned } of partnersOf(a)) {
            if (b.fullscreen) continue;
            test(`${layout}: pinned sidebar ${TOP_DRAWERS[id].name}, then ${partnerLabel(b, bPinned)} opened, then ${TOP_DRAWERS[id].name} turned fullscreen`, async ({ page }) => {
                await startScenario(page, { variants: [a, b], pinned: [a.id, ...(bPinned ? [b.id] : [])] });
                await openDrawer(page, a.id);
                await openDrawer(page, b.id);
                await expectStackCut(page, `after opening ${b.id}`, b.id);

                // Clicked as a user would: only if nothing covers the toggle.
                const toggleReachable = await page.locator(TOP_DRAWERS[id].fullscreenToggle).evaluate(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
                });
                if (!toggleReachable) {
                    test.info().annotations.push({ type: 'observed', description: `${a.id}'s fullscreen toggle covered after opening ${b.id}, so it can't be clicked; step skipped` });
                    return;
                }
                await page.locator(TOP_DRAWERS[id].fullscreenToggle).click();
                await expect(page.locator(`#${id}`)).toHaveClass(new RegExp(TOP_DRAWERS[id].fullscreenClass));
                await expectStackCut(page, `after turning ${a.id} fullscreen`, a.id);
            });
        }
    }

    // Pinned character info open, B opened, then a character selected through the extension API.
    for (const a of variantsOf('char-info-panel')) {
        for (const { b, bPinned } of partnersOf(a)) {
            test(`${layout}: pinned ${variantLabel(a)}, then ${partnerLabel(b, bPinned)} opened, then a character selected`, async ({ page }) => {
                const avatar = await createCharacter(page);
                await startScenario(page, { variants: [a, b], pinned: [a.id, ...(bPinned ? [b.id] : [])] });
                await openDrawer(page, a.id);
                await openDrawer(page, b.id);
                await expectStackCut(page, `after opening ${b.id}`, b.id);

                await page.evaluate(av => window['SillyTavern'].getContext().selectCharacterById(av), avatar);
                await expect(page.locator('#char-info-panel')).toHaveAttribute('data-active-menu', 'rm_ch_create_block');
                await expectStackCut(page, 'after selecting a character', 'char-info-panel');
            });
        }
    }
}

test.describe('Drawer overlap, desktop', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await setStackedDrawers(page, true);
    });

    test('pinned fullscreen character info brought forward over User Settings hides User Settings', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'user-settings-block');
        await expectStackCut(page, 'after opening user-settings-block', 'user-settings-block');
        await drawerIcon(page, 'char-info-panel').click();
        await expectStackCut(page, 'after clicking char-info-panel\'s icon', 'char-info-panel');
    });

    test('pinned fullscreen character management brought forward over Persona Management hides Persona Management', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'right-nav-panel', fullscreen: true }], pinned: ['right-nav-panel'] });
        await openDrawer(page, 'right-nav-panel');
        await openDrawer(page, 'PersonaManagement');
        await expectStackCut(page, 'after opening PersonaManagement', 'PersonaManagement');
        await drawerIcon(page, 'right-nav-panel').click();
        await expectStackCut(page, 'after clicking right-nav-panel\'s icon', 'right-nav-panel');
    });

    test('pinned World Info brought forward over User Settings hides User Settings', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['WorldInfo'] });
        await openDrawer(page, 'WorldInfo');
        await openDrawer(page, 'user-settings-block');
        await expectStackCut(page, 'after opening user-settings-block', 'user-settings-block');
        await drawerIcon(page, 'WorldInfo').click();
        await expectStackCut(page, 'after clicking WorldInfo\'s icon', 'WorldInfo');
    });

    test('pinned character info turned fullscreen over User Settings hides User Settings', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: false }], pinned: ['char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'user-settings-block');
        await expectStackCut(page, 'after opening user-settings-block', 'user-settings-block');
        await page.locator('#charInfoFullscreenToggle').click();
        await expectStackCut(page, 'after turning char-info-panel fullscreen', 'char-info-panel');
    });

    test('selecting a character while pinned fullscreen character info is behind User Settings hides User Settings', async ({ page }) => {
        const avatar = await createCharacter(page);
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'user-settings-block');
        await expectStackCut(page, 'after opening user-settings-block', 'user-settings-block');
        await page.evaluate(av => window['SillyTavern'].getContext().selectCharacterById(av), avatar);
        await expectStackCut(page, 'after selecting a character', 'char-info-panel');
    });

    test('while User Settings opens over pinned World Info, World Info is cut by its box frame by frame', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['WorldInfo'] });
        await openDrawer(page, 'WorldInfo');
        await expectStackCut(page, 'after opening WorldInfo', 'WorldInfo');
        const samples = await page.evaluate(() => new Promise(resolve => {
            const wi = document.getElementById('WorldInfo');
            const us = document.getElementById('user-settings-block');
            const icon = us.parentElement.querySelector(':scope > .drawer-toggle');
            const found = [];
            icon.click();
            const sample = () => {
                // After every frame callback has run, before the next frame: the boxes of this frame.
                setTimeout(() => {
                    const animating = us.getAnimations().length > 0;
                    const u = us.getBoundingClientRect();
                    const w = wi.getBoundingClientRect();
                    if (animating && u.height > 4 && u.bottom < w.bottom - 4) {
                        const x = w.left + w.width / 2;
                        const hitWi = y => document.elementsFromPoint(x, y).some(el => wi.contains(el));
                        found.push({ height: u.height, coveredHit: hitWi(u.bottom - 2), uncoveredHit: hitWi(u.bottom + 2) });
                    }
                    if (animating || found.length === 0 && performance.now() - start < 3000) requestAnimationFrame(sample);
                    else resolve(found);
                }, 0);
            };
            const start = performance.now();
            requestAnimationFrame(sample);
        }));
        // Mid-way, World Info is hidden just above User Settings' moving bottom edge and shows just below it.
        expect(samples.length).toBeGreaterThan(1);
        expect(samples.filter(s => s.coveredHit || !s.uncoveredHit)).toEqual([]);
        await expectStackCut(page, 'after User Settings finished opening', 'user-settings-block');
    });

    test('pinned fullscreen character info showing group creation stays visible beside World Info', async ({ page }) => {
        await startScenario(page, {
            variants: [{ id: 'char-info-panel', fullscreen: true }, { id: 'right-nav-panel', fullscreen: false }],
            pinned: ['char-info-panel'],
        });
        await openDrawer(page, 'right-nav-panel');
        await page.locator('#rm_button_group_chats').click();
        await expect(page.locator('#char-info-panel')).toHaveAttribute('data-active-menu', 'rm_group_chats_block');
        await expectStackCut(page, 'after opening group creation', 'char-info-panel');
        await openDrawer(page, 'WorldInfo');
        // Hidden or not, character info's box is laid out, so this checks it is drawn beside World Info.
        const boxesOverlap = await page.evaluate(() => {
            const a = document.getElementById('char-info-panel').getBoundingClientRect();
            const b = document.getElementById('WorldInfo').getBoundingClientRect();
            return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        });
        expect(boxesOverlap).toBe(false);
        await expectStackCut(page, 'after opening WorldInfo', 'WorldInfo', ['char-info-panel']);
    });

    drawerPairTests('desktop');
});

/**
 * Sets a User Settings number through its own input handler, as typing into it does.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {number} value
 */
async function setSettingInput(page, selector, value) {
    await page.locator(selector).evaluate((el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

/**
 * Moves the Chat Width slider as a drag does: the width is applied when the pointer is released, not on input.
 * @param {import('@playwright/test').Page} page
 * @param {number} value
 */
async function dragChatWidthSlider(page, value) {
    await page.locator('#chat_width_slider').evaluate((el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, value);
}

/**
 * The width in px of `n` ch, in character info's own font. Character info must be open.
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
function chWidthInCharInfo(page, n) {
    return page.locator('#char-info-panel').evaluate((panel, count) => {
        const probe = document.createElement('div');
        probe.style.cssText = `position: absolute; visibility: hidden; height: 0; width: ${count}ch;`;
        panel.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
    }, n);
}

/** @param {import('@playwright/test').Page} page */
function charInfoWidth(page) {
    return page.locator('#char-info-panel').evaluate(el => el.getBoundingClientRect().width);
}

test.describe('Character info fullscreen width', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await setStackedDrawers(page, true);
    });

    /**
     * Pinned AI Response Configuration open, then fullscreen character info opened in front of it, with Chat Width
     * Max set so the cap is 40% of a 1400px viewport: below the chat column's 50%, so both are exactly the cap wide.
     * @param {import('@playwright/test').Page} page
     * @returns {Promise<number>} The Chat Width Max set.
     */
    async function openCappedBesidePinnedLeftPanel(page) {
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['left-nav-panel'] });
        await openDrawer(page, 'left-nav-panel');
        await openDrawer(page, 'char-info-panel');
        const chatWidthMax = Math.floor(560 / await chWidthInCharInfo(page, 1));
        await setSettingInput(page, '#chat_width_max', chatWidthMax);
        await expect.poll(async () => Math.abs(await charInfoWidth(page) - await chWidthInCharInfo(page, chatWidthMax))).toBeLessThan(1);
        await expect.poll(() => page.locator('#sheld').evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(await charInfoWidth(page), 0);
        return chatWidthMax;
    }

    test('fullscreen character info is as wide as Chat Width Max and spans the sidebars when that is wider than the chat column', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['left-nav-panel'] });
        await openDrawer(page, 'left-nav-panel');
        await openDrawer(page, 'char-info-panel');
        // 1200px: wider than the 700px chat column, narrower than the 1400px viewport.
        const chatWidthMax = Math.floor(1200 / await chWidthInCharInfo(page, 1));
        await setSettingInput(page, '#chat_width_max', chatWidthMax);
        await expect.poll(async () => Math.abs(await charInfoWidth(page) - await chWidthInCharInfo(page, chatWidthMax))).toBeLessThan(1);
        await expectStackCut(page, 'capped wider than the chat column', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-stack-cut', 'true');
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    });

    test('fullscreen character info is as wide as the viewport when Chat Width Max is wider', async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['left-nav-panel'] });
        await openDrawer(page, 'left-nav-panel');
        await openDrawer(page, 'char-info-panel');
        await setSettingInput(page, '#chat_width_max', 500);
        await expect.poll(async () => Math.abs(await charInfoWidth(page) - await page.evaluate(() => window.innerWidth))).toBeLessThan(1);
        await expectStackCut(page, 'viewport wide', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-stack-cut', 'true');
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    });

    test('fullscreen character info capped to the chat column\'s width leaves pinned AI Response Configuration visible', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        await expectStackCut(page, 'capped to the chat column', 'char-info-panel', ['left-nav-panel']);
    });

    test('changing Chat Width Max changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        const chatWidthMax = await openCappedBesidePinnedLeftPanel(page);
        await setSettingInput(page, '#chat_width_max', 500);
        await expectStackCut(page, 'after raising Chat Width Max past the chat column', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-stack-cut', 'true');
        await setSettingInput(page, '#chat_width_max', chatWidthMax);
        await expectStackCut(page, 'after lowering Chat Width Max back', 'char-info-panel', ['left-nav-panel']);
    });

    test('changing Chat Width changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        // 30% of 1400px is narrower than the 560px cap, so the chat column shrinks and character info doesn't.
        await dragChatWidthSlider(page, 30);
        await expectStackCut(page, 'after narrowing Chat Width', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-stack-cut', 'true');
        await dragChatWidthSlider(page, 50);
        await expectStackCut(page, 'after widening Chat Width back', 'char-info-panel', ['left-nav-panel']);
    });

    test('resizing the window changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        // 50% of 1050px is narrower than the 560px cap, so the chat column shrinks and character info doesn't.
        await page.setViewportSize({ width: 1050, height: 900 });
        await expectStackCut(page, 'after narrowing the window', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toHaveAttribute('data-stack-cut', 'true');
        await page.setViewportSize({ width: 1400, height: 900 });
        await expectStackCut(page, 'after widening the window back', 'char-info-panel', ['left-nav-panel']);
    });
});

test.describe('Drawer overlap, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await setStackedDrawers(page, true);
    });

    drawerPairTests('mobile');
});

/** @param {import('@playwright/test').Page} page @param {string} selector */
function isShown(page, selector) {
    return page.locator(selector).evaluate(el => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
}

test.describe('Stacked drawers off', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await setStackedDrawers(page, false);
    });

    test('the two right-side pins act as one', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: [] });
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#charInfo_button_panel_pin')).toBeChecked();
        await expect(page.locator('#char-info-panel')).toHaveClass(/pinnedOpen/);
        await setPin(page, '#charInfo_button_panel_pin', false);
        await expect(page.locator('#rm_button_panel_pin')).not.toBeChecked();
        await expect(page.locator('#right-nav-panel')).not.toHaveClass(/pinnedOpen/);
    });

    test('opening either right-side panel closes the other, pinned, and the pin carries over', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'right-nav-panel', fullscreen: false }], pinned: ['right-nav-panel'] });
        await openDrawer(page, 'right-nav-panel');
        await openDrawer(page, 'char-info-panel');
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
        await expect(page.locator('#char-info-panel')).toHaveClass(/pinnedOpen/);
        await expect(page.locator('#char-info-panel')).toBeVisible();

        await openDrawer(page, 'right-nav-panel');
        await expect(page.locator('#char-info-panel')).toHaveClass(/closedDrawer/);
        await expect(page.locator('#right-nav-panel')).toHaveClass(/pinnedOpen/);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });

    test('pinned World Info stays visible under User Settings, the chat too, and its icon closes it', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['WorldInfo'] });
        await openDrawer(page, 'WorldInfo');
        await openDrawer(page, 'user-settings-block');
        await expect.poll(async () => (await drawerOverlapState(page)).visible.sort()).toEqual(['WorldInfo', 'user-settings-block']);
        expect(await isShown(page, '#sheld')).toBe(true);

        await drawerIcon(page, 'WorldInfo').click();
        await expect(page.locator('#WorldInfo')).toHaveClass(/closedDrawer/);
    });

    test('pinned fullscreen character management stays visible under Persona Management, the chat too', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'right-nav-panel', fullscreen: true }], pinned: ['right-nav-panel'] });
        await openDrawer(page, 'right-nav-panel');
        expect(await isShown(page, '#sheld')).toBe(true);
        await openDrawer(page, 'PersonaManagement');
        await expect.poll(async () => (await drawerOverlapState(page)).visible.sort()).toEqual(['PersonaManagement', 'right-nav-panel']);
        expect(await isShown(page, '#sheld')).toBe(true);
    });

    test('the zoomed avatar stays visible beside pinned AI Response Configuration', async ({ page }) => {
        // Fullscreen character info would cover the chat the helper clicks to close it.
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: false }], pinned: [] });
        await openChatWithCharacterMessage(page);
        await startScenario(page, { variants: [], pinned: ['left-nav-panel'] });
        await openDrawer(page, 'left-nav-panel');
        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
        await expect(page.locator('#left-nav-panel')).toBeVisible();
    });

    test('turning it off with only one right-side pin set pins both', async ({ page }) => {
        await setStackedDrawers(page, true);
        await startScenario(page, { variants: [], pinned: ['right-nav-panel'] });
        await expect(page.locator('#charInfo_button_panel_pin')).not.toBeChecked();
        await setStackedDrawers(page, false);
        await expect(page.locator('#charInfo_button_panel_pin')).toBeChecked();
        await expect(page.locator('#char-info-panel')).toHaveClass(/pinnedOpen/);
    });

    test('turning it off with both right-side panels open leaves only the front one open', async ({ page }) => {
        await setStackedDrawers(page, true);
        await startScenario(page, { variants: [{ id: 'right-nav-panel', fullscreen: false }], pinned: ['right-nav-panel', 'char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'right-nav-panel');
        await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
        await setStackedDrawers(page, false);
        await expect(page.locator('#char-info-panel')).toHaveClass(/closedDrawer/);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });

    test('a reload with differing saved right-side pins pins both', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['right-nav-panel'] });
        await page.evaluate(() => localStorage.setItem('CharInfoNavLockOn', 'false'));
        await page.reload();
        await awaitAppReady(page);
        await expect(page.locator('#charInfo_button_panel_pin')).toBeChecked();
        await expect(page.locator('#rm_button_panel_pin')).toBeChecked();
    });

    test('a theme saves the setting and applies it', async ({ page }) => {
        const name = `StackedDrawersTheme-${Date.now()}`;
        await setStackedDrawers(page, true);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/themes/save-from-settings') && response.ok());
        await page.locator('#ui-preset-save-button').evaluate(el => el.click());
        await page.locator('dialog[open] .popup-input').fill(name);
        await page.locator('dialog[open] .popup-button-ok').click();
        expect((await (await saved).json()).theme.stacked_drawers).toBe(true);

        await setStackedDrawers(page, false);
        await openDrawer(page, 'user-settings-block');
        await page.locator('#themes').selectOption(name);
        await expect(page.locator('body')).toHaveClass(/\bstackedDrawers\b/);
        await expect(page.locator('#stackedDrawers')).toBeChecked();
    });
});

test.describe('Stacked drawers off, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await setStackedDrawers(page, false);
    });

    test('pinned World Info stays visible under User Settings, the chat too', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['WorldInfo'] });
        await openDrawer(page, 'WorldInfo');
        await openDrawer(page, 'user-settings-block');
        await expect.poll(async () => (await drawerOverlapState(page)).visible.sort()).toEqual(['WorldInfo', 'user-settings-block']);
        expect(await isShown(page, '#sheld')).toBe(true);
    });
});

/**
 * Adds a window the way an extension does: a `.drawer-content` in #movingDivs, left of and over the chat's left edge,
 * holding a button that counts its clicks in `window.extWindowClicks`.
 * @param {import('@playwright/test').Page} page
 */
async function addExtensionWindow(page) {
    await page.evaluate(() => {
        const win = document.createElement('div');
        win.id = 'extWindow';
        win.className = 'drawer-content';
        const sheld = document.getElementById('sheld').getBoundingClientRect();
        // .drawer-content centers itself; an extension's window sits where it puts it.
        Object.assign(win.style, { position: 'fixed', left: `${sheld.left - 60}px`, right: 'auto', margin: '0', top: '120px', width: '260px', height: '220px', display: 'block' });
        const button = document.createElement('button');
        button.id = 'extWindowButton';
        button.textContent = 'x';
        Object.assign(button.style, { position: 'absolute', left: '8px', top: '8px', width: '30px', height: '30px' });
        window['extWindowClicks'] = 0;
        button.addEventListener('click', () => window['extWindowClicks']++);
        win.append(button);
        document.getElementById('movingDivs').append(win);
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{ x: number, y: number }>} A point inside both the extension window and the chat.
 */
function overlapPoint(page) {
    return page.evaluate(() => {
        const a = document.getElementById('extWindow').getBoundingClientRect();
        const b = document.getElementById('sheld').getBoundingClientRect();
        return { x: (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2, y: (a.top + a.bottom) / 2 };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number }} point
 * @returns {Promise<string>} Which of the two layers is hit there.
 */
function hitAt(page, point) {
    return page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit?.closest('#extWindow') ? 'extWindow' : hit?.closest('#sheld') ? 'sheld' : String(hit?.id);
    }, point);
}

test.describe('Layers found by what they are', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await setStackedDrawers(page, true);
        await resetDrawers(page);
    });

    test('a window an extension adds comes forward as it appears, and clicking the chat\'s visible part brings the chat forward', async ({ page }) => {
        await addExtensionWindow(page);
        const point = await overlapPoint(page);
        await expect.poll(() => hitAt(page, point)).toBe('extWindow');
        await expect.poll(async () => (await stackState(page)).cutWrong).toEqual([]);

        const sheld = await page.locator('#sheld').boundingBox();
        await page.mouse.click(sheld.x + sheld.width / 2, sheld.y + sheld.height / 2);
        await expect.poll(() => hitAt(page, point)).toBe('sheld');
        await expect.poll(async () => (await stackState(page)).layers.at(-1)).toBe('sheld');
        await expect.poll(async () => (await stackState(page)).cutWrong).toEqual([]);
        // The window still shows where the chat doesn't cover it.
        await expect(page.locator('#extWindow')).not.toHaveClass(/stackCovered/);
    });

    test('a button in a back layer still gets its click, and its layer comes forward', async ({ page }) => {
        await addExtensionWindow(page);
        const point = await overlapPoint(page);
        const sheld = await page.locator('#sheld').boundingBox();
        await page.mouse.click(sheld.x + sheld.width / 2, sheld.y + sheld.height / 2);
        await expect.poll(() => hitAt(page, point)).toBe('sheld');

        await page.locator('#extWindowButton').click();
        expect(await page.evaluate(() => window['extWindowClicks'])).toBe(1);
        await expect.poll(() => hitAt(page, point)).toBe('extWindow');
        await expect.poll(async () => (await stackState(page)).cutWrong).toEqual([]);
    });

    test('typing in the chat brings it forward', async ({ page }) => {
        await addExtensionWindow(page);
        const point = await overlapPoint(page);
        await expect.poll(() => hitAt(page, point)).toBe('extWindow');
        // Focus moved by the page itself doesn't bring a layer forward; typing does.
        await chatBox(page).evaluate(el => el.focus());
        expect(await hitAt(page, point)).toBe('extWindow');
        await page.keyboard.type('a');
        await expect.poll(() => hitAt(page, point)).toBe('sheld');
    });

    test('the lorebook\'s select2 dropdown cuts the layers under it', async ({ page }) => {
        await openDrawer(page, 'WorldInfo');
        await page.locator('#WorldInfo .select2-selection').first().click();
        const dropdown = page.locator('.select2-container--open > .select2-dropdown');
        await expect(dropdown).toBeVisible();
        await expect.poll(async () => (await stackState(page)).layers.at(-1)).toMatch(/^select2-dropdown/);
        await expect.poll(async () => (await stackState(page)).cutWrong).toEqual([]);
        await expect.poll(() => page.locator('#WorldInfo').evaluate(el => el.dataset.stackCut)).toBe('true');
    });
});
