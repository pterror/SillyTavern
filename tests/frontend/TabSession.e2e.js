import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// How a tab gets its session (public/scripts/tab-session.js): no two open tabs share one. A fresh tab takes the user's
// most recent session no tab holds, so closing a tab and opening a new one comes back to the same session; a
// duplicated tab, or a restored one whose session another tab took meanwhile, forks it from where it was.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function tabState(page) {
    return page.evaluate(async () => {
        const { tabSession, tabPlace } = await import('/scripts/tab-session.js');
        return { session: tabSession(), place: tabPlace() };
    });
}

/** The tab's sessionStorage of its session, as a duplicate or a restore brings it back. @param {import('@playwright/test').Page} page */
async function tabStorage(page) {
    return page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).filter(k => k.startsWith('st:tab-')).map(k => [k, sessionStorage.getItem(k)])));
}

/**
 * A tab opened with `storage` in its sessionStorage, as a browser's duplicated or restored tab is.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {Record<string, string>} storage
 */
async function tabWith(context, storage) {
    const page = await context.newPage();
    await page.addInitScript((s) => {
        if (sessionStorage.getItem('st:tab-session') !== null) return;
        for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
    }, storage);
    await testSetup.awaitST({ page });
    return page;
}

/** @param {import('@playwright/test').BrowserContext} context */
async function freshTab(context) {
    const page = await context.newPage();
    await testSetup.awaitST({ page });
    return page;
}

/**
 * Makes a character and moves the tab's session to it (its greeting chosen), waiting until the tab is told.
 * @param {import('@playwright/test').Page} page
 */
async function moveToNewCharacter(page) {
    const { place } = await tabState(page);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await page.evaluate(async (name) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        const avatar = await response.text();
        const chose = await fetch('/api/chats/openings/choose', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, index: 0 }) });
        if (!chose.ok) throw new Error(`choose failed: ${chose.status}`);
    }, `Tab-${stamp}`);
    await expect.poll(async () => (await tabState(page)).place.length).toBe(place.length + 1);
}

/** Waits until the server has seen a closed tab's stream go. */
const settle = () => new Promise(resolve => setTimeout(resolve, 500));

test('two tabs open at once never share a session; closing one and opening a new tab comes back to it', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        const first = await freshTab(context);
        await moveToNewCharacter(first);
        const { session } = await tabState(first);
        expect(session).not.toBeNull();

        const second = await freshTab(context);
        expect((await tabState(second)).session).not.toBe(session);

        await first.close();
        await settle();
        const reopened = await freshTab(context);
        expect((await tabState(reopened)).session).toBe(session);
    } finally {
        await context.close();
    }
});

test('fresh tabs on two devices at once never get the same session', async ({ browser, baseURL }) => {
    const setup = await browser.newContext({ baseURL });
    const one = await browser.newContext({ baseURL });
    const two = await browser.newContext({ baseURL });
    try {
        const page = await freshTab(setup);
        await moveToNewCharacter(page);
        await setup.close();
        const [a, b] = await Promise.all([freshTab(one), freshTab(two)]);
        const [sa, sb] = [(await tabState(a)).session, (await tabState(b)).session];
        expect(sa).not.toBeNull();
        expect(sb).not.toBeNull();
        expect(sa).not.toBe(sb);
    } finally {
        await one.close();
        await two.close();
    }
});

test('a restored tab goes on with its own session', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        const page = await freshTab(context);
        await moveToNewCharacter(page);
        const before = await tabState(page);
        const storage = await tabStorage(page);
        await page.close();
        await settle();
        const restored = await tabWith(context, storage);
        expect(await tabState(restored)).toEqual(before);
    } finally {
        await context.close();
    }
});

test('a duplicated tab forks the session: the history so far, then each moves on its own', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        const original = await freshTab(context);
        await moveToNewCharacter(original);
        await moveToNewCharacter(original);
        const before = await tabState(original);

        const duplicate = await tabWith(context, await tabStorage(original));
        const forked = await tabState(duplicate);
        expect(forked.session).not.toBe(before.session);
        expect(forked.place).toEqual(before.place);

        await moveToNewCharacter(duplicate);
        expect(await tabState(original)).toEqual(before);
        await moveToNewCharacter(original);
        expect((await tabState(original)).session).toBe(before.session);
        expect((await tabState(duplicate)).place).toEqual({ length: before.place.length + 1, cursor: before.place.length + 1 });
    } finally {
        await context.close();
    }
});

test('a restored tab whose session another tab took resumes at its own last place', async ({ browser, baseURL }) => {
    const here = await browser.newContext({ baseURL });
    const elsewhere = await browser.newContext({ baseURL });
    try {
        const page = await freshTab(here);
        await moveToNewCharacter(page);
        await moveToNewCharacter(page);
        const before = await tabState(page);
        const storage = await tabStorage(page);
        await page.close();
        await settle();

        // Another device's new tab takes it and moves on.
        const taker = await freshTab(elsewhere);
        expect((await tabState(taker)).session).toBe(before.session);
        await moveToNewCharacter(taker);

        const restored = await tabWith(here, storage);
        const now = await tabState(restored);
        expect(now.session).not.toBe(before.session);
        expect(now.place).toEqual(before.place);
        expect((await tabState(taker)).session).toBe(before.session);
    } finally {
        await here.close();
        await elsewhere.close();
    }
});

/** The browser gives no Web Locks (plain http to a LAN address). @param {import('@playwright/test').BrowserContext} context */
async function withoutWebLocks(context) {
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });
}

test('without Web Locks, a duplicated tab still forks: the later loaded of two tabs sharing a token takes a new one', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        await withoutWebLocks(context);
        const original = await freshTab(context);
        expect(await original.evaluate(() => navigator.locks)).toBeUndefined();
        await moveToNewCharacter(original);
        await moveToNewCharacter(original);
        const before = await tabState(original);
        const storage = await tabStorage(original);

        const duplicate = await tabWith(context, storage);
        expect(await duplicate.evaluate(() => navigator.locks)).toBeUndefined();
        await expect.poll(async () => (await tabState(duplicate)).session).not.toBe(before.session);
        expect((await tabState(duplicate)).place).toEqual(before.place);
        expect((await tabStorage(duplicate))['st:tab-token']).not.toBe(storage['st:tab-token']);

        // The earlier tab keeps its session and token, and each moves on its own.
        expect(await tabState(original)).toEqual(before);
        expect((await tabStorage(original))['st:tab-token']).toBe(storage['st:tab-token']);
        await moveToNewCharacter(duplicate);
        expect(await tabState(original)).toEqual(before);
        await moveToNewCharacter(original);
        expect((await tabState(original)).session).toBe(before.session);
    } finally {
        await context.close();
    }
});

test('a stream that fails to connect does not hold the page; the tab goes on without a session and takes the one the stream gives it', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    try {
        let down = true;
        await context.route('**/api/characters/changes/stream*', route => (down ? route.abort() : route.continue()));
        const page = await context.newPage();
        /** @type {string[]} */
        const sessionsSent = [];
        page.on('request', r => {
            const h = r.headers()['x-st-session'];
            if (h !== undefined) sessionsSent.push(h);
        });
        await testSetup.awaitST({ page });
        expect((await tabState(page)).session).toBeNull();
        expect(sessionsSent).toContain('none');
        down = false;
        await expect.poll(async () => (await tabState(page)).session, { timeout: 30000 }).not.toBeNull();
    } finally {
        await context.close();
    }
});
