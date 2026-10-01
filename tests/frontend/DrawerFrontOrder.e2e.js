import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers, findCharacterAvatarByName } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

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
    const sendTextarea = page.locator('#send_textarea');
    await sendTextarea.fill(`/sendas name="${name}" hello`);
    // Enter can go unhandled while the freshly selected chat loads; the text stays in the box until it is sent.
    await expect(async () => {
        if (await sendTextarea.inputValue()) {
            await sendTextarea.press('Enter');
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

    test('character info brought forward over character management uncovers the zoomed avatar', async ({ page }) => {
        await openChatWithCharacterMessage(page);
        // Both pinned, so the avatar click below doesn't just close them; character management in front.
        await page.locator('#charInfoDrawerIcon').click();
        await setPin(page, '#charInfo_button_panel_pin', true);
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel')).toBeVisible();
        await expect(page.locator('#char-info-panel')).toBeHidden();

        await page.locator('#charInfoDrawerIcon').click();
        await expect(page.locator('#char-info-panel')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#chat .mes .avatar').first().click();
        await expect(page.locator('.zoomed_avatar[forChar] .zoomed_avatar_img')).toBeVisible();
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
        await expect(page.locator('#right-nav-panel')).toBeHidden();

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeVisible();
    });

    test('API connections opened over pinned fullscreen character management is on top', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await setPin(page, '#rm_button_panel_pin', true);
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();

        await page.locator('#API-status-top').click();
        const apiBlock = page.locator('#rm_api_block');
        await expect(apiBlock).toBeVisible();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
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
 * @returns {Promise<{ open: string[], visible: string[], overlaps: string[] }>}
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
        return { open: open.map(el => el.id), visible: visible.map(el => el.id), overlaps };
    });
}

/**
 * Soft-asserts that `frontId` is visible and no two visible drawers overlap, and records what was seen.
 * @param {import('@playwright/test').Page} page
 * @param {string} step What the check is after, for the record.
 * @param {string} frontId The drawer the last action put in front.
 * @param {string[]} [alsoVisible] Drawers that don't overlap `frontId` and so must stay visible beside it.
 */
async function expectOneVisibleWhereOverlapping(page, step, frontId, alsoVisible = []) {
    const mustBeVisible = [frontId, ...alsoVisible];
    const summarize = state => ({ hiddenButRequired: mustBeVisible.filter(id => !state.visible.includes(id)), overlaps: state.overlaps });
    // Drawers settle over several frames after an action; judging a passing moment mid-way could miss an overlap that
    // shows up once they have settled.
    let previous;
    await expect.poll(async () => {
        const current = JSON.stringify(await drawerOverlapState(page));
        const settled = current === previous;
        previous = current;
        return settled;
    }, { intervals: [300] }).toBe(true);
    await expect.configure({ soft: true }).poll(async () => summarize(await drawerOverlapState(page)), { message: step }).toEqual({ hiddenButRequired: [], overlaps: [] });
    test.info().annotations.push({ type: 'observed', description: `${step}: ${JSON.stringify(await drawerOverlapState(page))}` });
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
                    await expectOneVisibleWhereOverlapping(page, `after opening ${b.id}`, b.id);

                    const { visible, open } = await drawerOverlapState(page);
                    if (!open.includes(a.id) || visible.includes(a.id)) {
                        test.info().annotations.push({ type: 'observed', description: `${a.id} not open-and-hidden after opening ${b.id}; icon click would not bring it forward, step skipped` });
                        return;
                    }
                    await drawerIcon(page, a.id).click();
                    await expectOneVisibleWhereOverlapping(page, `after clicking ${a.id}'s icon`, a.id);
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
                await expectOneVisibleWhereOverlapping(page, `after opening ${b.id}`, b.id);

                if (!(await drawerOverlapState(page)).visible.includes(a.id)) {
                    test.info().annotations.push({ type: 'observed', description: `${a.id} not visible after opening ${b.id}, so its fullscreen toggle can't be clicked; step skipped` });
                    return;
                }
                await page.locator(TOP_DRAWERS[id].fullscreenToggle).click();
                await expect(page.locator(`#${id}`)).toHaveClass(new RegExp(TOP_DRAWERS[id].fullscreenClass));
                await expectOneVisibleWhereOverlapping(page, `after turning ${a.id} fullscreen`, a.id);
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
                await expectOneVisibleWhereOverlapping(page, `after opening ${b.id}`, b.id);

                await page.evaluate(av => window['SillyTavern'].getContext().selectCharacterById(av), avatar);
                await expect(page.locator('#char-info-panel')).toHaveAttribute('data-active-menu', 'rm_ch_create_block');
                await expectOneVisibleWhereOverlapping(page, 'after selecting a character', 'char-info-panel');
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
        await expectOneVisibleWhereOverlapping(page, 'after opening user-settings-block', 'user-settings-block');
        await drawerIcon(page, 'char-info-panel').click();
        await expectOneVisibleWhereOverlapping(page, 'after clicking char-info-panel\'s icon', 'char-info-panel');
    });

    test('pinned fullscreen character management brought forward over Persona Management hides Persona Management', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'right-nav-panel', fullscreen: true }], pinned: ['right-nav-panel'] });
        await openDrawer(page, 'right-nav-panel');
        await openDrawer(page, 'PersonaManagement');
        await expectOneVisibleWhereOverlapping(page, 'after opening PersonaManagement', 'PersonaManagement');
        await drawerIcon(page, 'right-nav-panel').click();
        await expectOneVisibleWhereOverlapping(page, 'after clicking right-nav-panel\'s icon', 'right-nav-panel');
    });

    test('pinned World Info brought forward over User Settings hides User Settings', async ({ page }) => {
        await startScenario(page, { variants: [], pinned: ['WorldInfo'] });
        await openDrawer(page, 'WorldInfo');
        await openDrawer(page, 'user-settings-block');
        await expectOneVisibleWhereOverlapping(page, 'after opening user-settings-block', 'user-settings-block');
        await drawerIcon(page, 'WorldInfo').click();
        await expectOneVisibleWhereOverlapping(page, 'after clicking WorldInfo\'s icon', 'WorldInfo');
    });

    test('pinned character info turned fullscreen over User Settings hides User Settings', async ({ page }) => {
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: false }], pinned: ['char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'user-settings-block');
        await expectOneVisibleWhereOverlapping(page, 'after opening user-settings-block', 'user-settings-block');
        await page.locator('#charInfoFullscreenToggle').click();
        await expectOneVisibleWhereOverlapping(page, 'after turning char-info-panel fullscreen', 'char-info-panel');
    });

    test('selecting a character while pinned fullscreen character info is behind User Settings hides User Settings', async ({ page }) => {
        const avatar = await createCharacter(page);
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['char-info-panel'] });
        await openDrawer(page, 'char-info-panel');
        await openDrawer(page, 'user-settings-block');
        await expectOneVisibleWhereOverlapping(page, 'after opening user-settings-block', 'user-settings-block');
        await page.evaluate(av => window['SillyTavern'].getContext().selectCharacterById(av), avatar);
        await expectOneVisibleWhereOverlapping(page, 'after selecting a character', 'char-info-panel');
    });

    test('pinned fullscreen character info showing group creation stays visible beside World Info', async ({ page }) => {
        await startScenario(page, {
            variants: [{ id: 'char-info-panel', fullscreen: true }, { id: 'right-nav-panel', fullscreen: false }],
            pinned: ['char-info-panel'],
        });
        await openDrawer(page, 'right-nav-panel');
        await page.locator('#rm_button_group_chats').click();
        await expect(page.locator('#char-info-panel')).toHaveAttribute('data-active-menu', 'rm_group_chats_block');
        await expectOneVisibleWhereOverlapping(page, 'after opening group creation', 'char-info-panel');
        await openDrawer(page, 'WorldInfo');
        // Hidden or not, character info's box is laid out, so this checks it is drawn beside World Info.
        const boxesOverlap = await page.evaluate(() => {
            const a = document.getElementById('char-info-panel').getBoundingClientRect();
            const b = document.getElementById('WorldInfo').getBoundingClientRect();
            return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        });
        expect(boxesOverlap).toBe(false);
        await expectOneVisibleWhereOverlapping(page, 'after opening WorldInfo', 'WorldInfo', ['char-info-panel']);
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
        await expectOneVisibleWhereOverlapping(page, 'capped wider than the chat column', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toBeHidden();
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    });

    test('fullscreen character info is as wide as the viewport when Chat Width Max is wider', async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await startScenario(page, { variants: [{ id: 'char-info-panel', fullscreen: true }], pinned: ['left-nav-panel'] });
        await openDrawer(page, 'left-nav-panel');
        await openDrawer(page, 'char-info-panel');
        await setSettingInput(page, '#chat_width_max', 500);
        await expect.poll(async () => Math.abs(await charInfoWidth(page) - await page.evaluate(() => window.innerWidth))).toBeLessThan(1);
        await expectOneVisibleWhereOverlapping(page, 'viewport wide', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toBeHidden();
        await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);
    });

    test('fullscreen character info capped to the chat column\'s width leaves pinned AI Response Configuration visible', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        await expectOneVisibleWhereOverlapping(page, 'capped to the chat column', 'char-info-panel', ['left-nav-panel']);
    });

    test('changing Chat Width Max changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        const chatWidthMax = await openCappedBesidePinnedLeftPanel(page);
        await setSettingInput(page, '#chat_width_max', 500);
        await expectOneVisibleWhereOverlapping(page, 'after raising Chat Width Max past the chat column', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toBeHidden();
        await setSettingInput(page, '#chat_width_max', chatWidthMax);
        await expectOneVisibleWhereOverlapping(page, 'after lowering Chat Width Max back', 'char-info-panel', ['left-nav-panel']);
    });

    test('changing Chat Width changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        // 30% of 1400px is narrower than the 560px cap, so the chat column shrinks and character info doesn't.
        await dragChatWidthSlider(page, 30);
        await expectOneVisibleWhereOverlapping(page, 'after narrowing Chat Width', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toBeHidden();
        await dragChatWidthSlider(page, 50);
        await expectOneVisibleWhereOverlapping(page, 'after widening Chat Width back', 'char-info-panel', ['left-nav-panel']);
    });

    test('resizing the window changes whether fullscreen character info hides pinned AI Response Configuration', async ({ page }) => {
        await openCappedBesidePinnedLeftPanel(page);
        // 50% of 1050px is narrower than the 560px cap, so the chat column shrinks and character info doesn't.
        await page.setViewportSize({ width: 1050, height: 900 });
        await expectOneVisibleWhereOverlapping(page, 'after narrowing the window', 'char-info-panel');
        await expect(page.locator('#left-nav-panel')).toBeHidden();
        await page.setViewportSize({ width: 1400, height: 900 });
        await expectOneVisibleWhereOverlapping(page, 'after widening the window back', 'char-info-panel', ['left-nav-panel']);
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
