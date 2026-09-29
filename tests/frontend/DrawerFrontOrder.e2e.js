import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

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
    const findAvatar = () => page.evaluate(n => window['SillyTavern'].getContext().characters.find(c => c?.name === n)?.avatar, name);
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

test.describe('Drawer overlap, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    drawerPairTests('mobile');
});
