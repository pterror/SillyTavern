import { test, expect } from '@playwright/test';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// "Prune unused tags" must only remove tags that no character or group uses anywhere on the server - not
// judged by what this page happens to have loaded, synced or counted.

/**
 * Loads the app and waits for APP_READY (all characters/groups resident), answering the one-time welcome popup.
 * @param {import('@playwright/test').Page} page
 */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    // APP_READY is an auto-fire event: a listener added after it was emitted still runs.
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    const okButton = page.locator('.popup-button-ok').first();
    if (await okButton.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
        await okButton.click();
        await okButton.waitFor({ state: 'hidden', timeout: 5000 });
    }
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
    }, { path, body });
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} avatar */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} tag id */
async function createTag(page, name) {
    const id = `tag-prune-${name}`;
    await api(page, '/api/tags/upsert', {
        tag: {
            id, name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
        },
    });
    return id;
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
async function serverTagIds(page) {
    const { tags } = await api(page, '/api/tags/get');
    return tags.map(t => t.id);
}

/** @param {import('@playwright/test').Page} page @returns {Promise<Record<string, number>>} */
async function serverTagUsage(page) {
    return page.evaluate(async () => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        return (await fetch('/api/tags/usage', { headers })).json();
    });
}

/**
 * Creates the fixture data from a throwaway browser context, so the page under test starts with an empty
 * IndexedDB character cache and learns about everything only through its own boot.
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withSetupPage(browser, fn) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await loadApp(page);
        return await fn(page);
    } finally {
        await context.close();
    }
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Counts /api/tags/* requests still in flight, so a test can wait until whatever a prune sent has landed.
 * @param {import('@playwright/test').Page} page
 */
function trackTagRequests(page) {
    const inFlight = new Set();
    const isTags = request => new URL(request.url()).pathname.startsWith('/api/tags/');
    page.on('request', r => { if (isTags(r)) inFlight.add(r); });
    page.on('requestfinished', r => inFlight.delete(r));
    page.on('requestfailed', r => inFlight.delete(r));
    return inFlight;
}

/**
 * Clicks "prune", accepts whatever it offers, and waits until the prune is fully done (server included).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} the confirm popup's text ('' if prune found nothing to offer)
 */
async function pruneAndAccept(page) {
    const requests = trackTagRequests(page);
    await page.locator('#tag_view_list .tag_view_prune').click();
    const confirmPopup = page.locator('dialog.popup', { hasText: /Prune \d+ tags/ });
    const noneToast = page.locator('.toast', { hasText: 'No unused tags found' });
    await expect(confirmPopup.or(noneToast).first()).toBeVisible({ timeout: 10000 });
    let offered = '';
    if (await confirmPopup.isVisible()) {
        offered = await confirmPopup.innerText();
        await confirmPopup.locator('.popup-button-ok').click();
        await expect(page.locator('.toast', { hasText: /pruned/i }).first()).toBeVisible({ timeout: 10000 });
    }
    await expect.poll(() => requests.size, { timeout: 30000 }).toBe(0);
    return offered;
}

test.describe('Tag prune keeps tags that are in use', () => {
    test.setTimeout(180000);

    test('after a restore, keeps a tag used only by a card this page has not loaded', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const hiddenTag = await createTag(setup, `hidden-${stamp}`);
            const restoredTag = await createTag(setup, `restored-${stamp}`);
            const hiddenCard = await createCharacter(setup, `TagPruneHidden-${stamp}`);
            const visibleCard = await createCharacter(setup, `TagPruneVisible-${stamp}`);
            await api(setup, '/api/tags/assign', { id: hiddenCard, tagId: hiddenTag });
            return { hiddenTag, restoredTag, hiddenCard, visibleCard };
        });

        // The page never receives hiddenCard: dropped from the change log and from any batch fetch.
        await page.route('**/api/characters/changes', async route => {
            const response = await route.fetch();
            const json = await response.json();
            json.changes = json.changes.filter(c => c.id !== fixture.hiddenCard);
            await route.fulfill({ response, json });
        });
        await page.route('**/api/characters/batch', async route => {
            const response = await route.fetch();
            const json = await response.json();
            await route.fulfill({ response, json: json.filter(c => c.avatar !== fixture.hiddenCard) });
        });

        await loadApp(page);
        expect(await page.evaluate(a => window['SillyTavern'].getContext().characters.some(c => c.avatar === a), fixture.hiddenCard)).toBe(false);
        expect((await serverTagUsage(page))[fixture.hiddenTag]).toBe(1);

        await openTagManagement(page);

        // Restore a backup that touches only the visible card.
        const backup = {
            tags: [{ id: fixture.restoredTag, name: `restored-${stamp}`, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000, color: '', color2: '' }],
            tag_map: { [fixture.visibleCard]: [fixture.restoredTag] },
        };
        const chooserPromise = page.waitForEvent('filechooser');
        await page.locator('#tag_view_list .tag_view_restore').click();
        const chooser = await chooserPromise;
        await chooser.setFiles({ name: 'tags_backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
        const overwritePopup = page.locator('dialog.popup', { hasText: 'You have existing tags' });
        await overwritePopup.locator('.popup-button-cancel').click();
        await expect(page.locator('.toast', { hasText: /Tags restored/ }).first()).toBeVisible({ timeout: 15000 });

        await pruneAndAccept(page);

        expect(await serverTagIds(page)).toContain(fixture.hiddenTag);
    });

    test('keeps a tag another client assigned after this page loaded', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = await createTag(setup, `other-client-${stamp}`);
            const card = await createCharacter(setup, `TagPruneOtherClient-${stamp}`);
            return { tag, card };
        });

        await loadApp(page);
        // Change-stream syncs are deferred while the character list is hidden.
        await openCharacterManagementDrawer(page);

        // A second tab in the same browser assigns the (so far unused) tag.
        const other = await page.context().newPage();
        await loadApp(other);
        await api(other, '/api/tags/assign', { id: fixture.card, tagId: fixture.tag });
        await other.close();

        // Wait for this page to sync the assignment onto its own copy of the card, so what's left is prune itself.
        await expect.poll(() => page.evaluate(({ card, tag }) => {
            const c = window['SillyTavern'].getContext().characters.find(x => x.avatar === card);
            return Boolean(c?.tag_ids?.includes(tag));
        }, fixture), { timeout: 30000 }).toBe(true);

        await openTagManagement(page);
        await pruneAndAccept(page);

        expect(await serverTagIds(page)).toContain(fixture.tag);
    });

    test('keeps tags in use when the usage-count fetch failed at boot', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = await createTag(setup, `usage-failed-${stamp}`);
            const card = await createCharacter(setup, `TagPruneUsageFailed-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });

        await page.route('**/api/tags/usage', route => route.fulfill({ status: 500, body: 'unavailable' }));
        await loadApp(page);
        // The card and its tag assignment are resident here; only the usage aggregate is missing.
        expect(await page.evaluate(({ card, tag }) => {
            const c = window['SillyTavern'].getContext().characters.find(x => x.avatar === card);
            return Boolean(c?.tag_ids?.includes(tag));
        }, fixture)).toBe(true);

        await openTagManagement(page);
        await pruneAndAccept(page);

        await page.unroute('**/api/tags/usage');
        expect(await serverTagIds(page)).toContain(fixture.tag);
    });
});
