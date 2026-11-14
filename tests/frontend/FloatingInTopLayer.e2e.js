import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Rules in the shipped CSS that place something `fixed` and are not floating surfaces, each with why. Everything else
 * placed `fixed` is a popover or a dialog, and says so in its selector.
 */
const FIXED_BUT_NOT_FLOATING = {
    '.editorLayer': 'a panel in #movingDivs',
    '#cfgConfig': 'a panel in #movingDivs',
    '#floatingPrompt': 'a panel in #movingDivs',
    '.fillRight': 'drawers beside the chat',
    '.fillLeft': 'drawers beside the chat',
    '.drawer-content': 'drawers (mobile)',
    'body.forceMobileView .drawer-content': 'drawers (forced mobile view)',
    '#Worldbuilding.drawer-content': 'a drawer',
    '#top-bar': 'the bar the drawers hang from (mobile)',
    '#top-settings-holder': 'the bar the drawers hang from (mobile)',
    'body.forceMobileView #top-settings-holder': 'the bar the drawers hang from (forced mobile view)',
    'body.forceMobileView #top-bar': 'the bar the drawers hang from (forced mobile view)',
    'body.drawerBarBottom:not(.forceMobileView) #top-settings-holder': 'the bar the drawers hang from, at the bottom',
    'body:is(.drawerBarLeft, .drawerBarRight):not(.forceMobileView) #top-settings-holder': 'the bar the drawers hang from, at a side',
    'body': 'the page itself (mobile)',
    'body.forceMobileView': 'the page itself (forced mobile view)',
    '#chat .style-pins': 'hidden, off screen: holds pinned styles, draws nothing',
    '#bg_menu': 'no element in the page has this id',
    '#nav-toggle': 'no element in the page has this id',
    '#toast-container': 'toastr\'s own stylesheet; the page shows the container as a popover',
    '.select2-close-mask': 'select2\'s own stylesheet; select2 4.1 makes no close mask',
    '.cm-announced': 'CodeMirror\'s text for screen readers, off screen',
};

/** What the page is made of: shown where it is, not floating over it */
const PAGE = '#bg1, #bg_custom, #top-bar, #top-settings-holder, #movingDivs, #sheld, .drawer-content, #movingDivs > *, body > .draggable';
const PANELS = '#sheld, .drawer-content, #movingDivs > *, body > .draggable';

/**
 * Every selector of a rule in the page's stylesheets that places something `fixed` (nested rules joined to their
 * parents', CodeMirror's generated scope classes left out), whatever media or support condition it is under
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
function fixedRules(page) {
    return page.evaluate(() => {
        const out = [];
        /** @param {string} list */
        const each = (list) => {
            const parts = [];
            let depth = 0;
            let start = 0;
            for (let i = 0; i < list.length; i++) {
                if ('([' .includes(list[i])) depth++;
                else if (')]'.includes(list[i])) depth--;
                else if (list[i] === ',' && depth === 0) {
                    parts.push(list.slice(start, i));
                    start = i + 1;
                }
            }
            parts.push(list.slice(start));
            return parts.map(part => part.replace(/\.ͼ\w+\s*/g, '').trim());
        };
        /**
         * @param {CSSRuleList} rules
         * @param {string} parent
         */
        const walk = (rules, parent) => {
            for (const rule of rules) {
                if (rule instanceof CSSStyleRule) {
                    const selector = parent ? rule.selectorText.replaceAll('&', parent) : rule.selectorText;
                    const full = parent && !rule.selectorText.includes('&') ? `${parent} ${selector}` : selector;
                    if (rule.style.getPropertyValue('position').trim() === 'fixed') out.push(...each(full));
                    walk(rule.cssRules, full);
                } else if ('cssRules' in rule) {
                    walk(/** @type {CSSGroupingRule} */ (rule).cssRules, parent);
                }
            }
        };
        for (const sheet of document.styleSheets) {
            let rules;
            try {
                rules = sheet.cssRules;
            } catch {
                continue;
            }
            walk(rules, '');
        }
        return out;
    });
}

/**
 * Every element drawn floating outside the top layer: placed `fixed`, placed `absolute` against the page, or layered by
 * z-index outside every panel, when it isn't part of the page itself, isn't in an open popover or modal dialog, and
 * draws something in the window
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
function floatingOutsideTopLayer(page) {
    return page.evaluate(({ pageSelector, panels }) => {
        const out = [];
        for (const el of document.body.querySelectorAll('*')) {
            if (!(el instanceof HTMLElement) || el.closest(':popover-open, dialog:modal') || el.matches(pageSelector)) continue;
            if (!el.checkVisibility({ visibilityProperty: true })) continue;
            const box = el.getBoundingClientRect();
            const offScreen = box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight;
            if ((box.width <= 1 && box.height <= 1) || offScreen) continue;
            const style = getComputedStyle(el);
            const againstPage = style.position === 'absolute' && (!el.offsetParent || el.offsetParent === document.body);
            const layered = style.position !== 'static' && style.zIndex !== 'auto' && !el.parentElement?.closest(panels);
            if (style.position === 'fixed' || againstPage || layered) {
                out.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].map(c => `.${c}`).join('')} (${style.position}, z-index ${style.zIndex})`);
            }
        }
        return [...new Set(out)];
    }, { pageSelector: PAGE, panels: PANELS });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

const settle = (/** @type {import('@playwright/test').Page} */ page) => page.waitForTimeout(500);

test.describe('what floats is in the top layer', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
    });

    test('the shipped CSS places nothing fixed but popovers, dialogs and the page\'s own parts', async ({ page }) => {
        const rules = await fixedRules(page);
        const inTopLayer = (/** @type {string} */ selector) => /\[popover\]|:popover-open|\bdialog\b|:modal/.test(selector);
        expect(rules.filter(selector => !inTopLayer(selector) && !Object.hasOwn(FIXED_BUT_NOT_FLOATING, selector))).toEqual([]);
        expect(Object.keys(FIXED_BUT_NOT_FLOATING).filter(selector => !rules.includes(selector))).toEqual([]);
    });

    test('nothing the main surfaces open floats outside a popover or dialog', async ({ page }) => {
        test.setTimeout(120000);
        await setStackedDrawers(page, true);
        /** @type {Record<string, string[]>} */
        const found = {};
        const sweep = async (/** @type {string} */ state) => {
            await settle(page);
            const floating = await floatingOutsideTopLayer(page);
            if (floating.length) found[state] = floating;
        };
        await sweep('start');

        await openCharacterManagementDrawer(page);
        await page.locator('.character_select', { hasText: 'Alice' }).first().click();
        await sweep('a chat');

        await page.locator('#talkativeness_button').click();
        await expect(page.locator('#talkativeness_div')).toBeVisible();
        await sweep('the talkativeness popover');
        await page.locator('#talkativeness_button').click();

        await page.locator('#options_button').click();
        await expect(page.locator('#options')).toBeVisible();
        await sweep('the options menu');
        await page.locator('#options_button').click();

        await page.evaluate(() => { window['toastr'].info('A toast.'); });
        await expect(page.locator('#toast-container .toast')).toBeVisible();
        await sweep('a toast');

        await page.evaluate(() => { void window['stTest'].context().callGenericPopup('A popup.', 1); });
        await expect(page.locator('dialog.popup[open]')).toBeVisible();
        await sweep('a popup');
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog.popup[open]')).toHaveCount(0);

        await chatBox(page).click();
        await page.keyboard.type('/sen');
        await expect(page.locator('#chat_box .cm-tooltip-autocomplete')).toBeVisible();
        await sweep('slash command suggestions');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.type('Hi {{cha');
        await expect(page.locator('#chat_box .cm-tooltip-autocomplete')).toBeVisible();
        await sweep('macro suggestions');
        await page.keyboard.press('Escape');

        await page.locator('#rightNavDrawerIcon').click();
        if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
        await page.locator('#character_search_bar').pressSequentially('name:bob ');
        await page.locator('#character_search_pills .search_pill[data-field] .search_pill_label').click();
        await expect(page.locator('.view_pill_popover')).toBeVisible();
        await sweep('a search pill\'s popover');
        await page.keyboard.press('Escape');
        await page.locator('#character_view_picker').click();
        await expect(page.locator('.view_picker_popover')).toBeVisible();
        await sweep('the saved view picker');
        await page.keyboard.press('Escape');

        const drawers = await page.evaluate(() => [...document.querySelectorAll('#top-settings-holder > .drawer')]
            .filter(el => el.checkVisibility()).map(el => el.id));
        for (const id of drawers) {
            await page.locator(`#${id} > .drawer-toggle`).click();
            await sweep(`drawer ${id}`);
            await page.locator(`#${id} > .drawer-toggle`).click();
        }

        expect(found).toEqual({});
    });
});
