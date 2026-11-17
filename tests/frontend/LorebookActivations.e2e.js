import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';
import { connectLlamaCpp } from './llamacpp-mock.js';
import { makeWorld } from './worlds.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const MODEL = 'lorebook-activations-model';

function startLlamaCpp() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (/** @type {any} */ value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-lore', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') {
                const text = 'It hangs by the door.';
                if (JSON.parse(body || '{}').stream === false) {
                    return json({ content: text, stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 });
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ content: text, stop: false })}\n\n`);
                res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                return;
            }
            if (path === '/health' || path === '/slots') return json({});
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return /** @type {Promise<{ url: string, close: () => Promise<unknown> }>} */ (new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    }));
}

const LANTERN = { uid: 0, key: ['lantern'], keysecondary: [], comment: 'The lantern', content: 'The lantern never goes out.', position: 0, order: 10, disable: false };

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} book
 * @param {Record<number, object>} [entries]
 */
async function createCharacterAndBook(page, name, book, entries = { 0: LANTERN }) {
    await makeWorld(page, book, entries);
    await page.locator('#WIDrawerIcon').click();
    await expect(page.locator('#Worldbuilding')).not.toBeVisible();
    return page.evaluate(async ({ name, book }) => {
        // @ts-ignore
        const context = stTest.context();
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Welcome in.');
        const created = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        if (!created.ok) throw new Error(`create failed: ${created.status}`);
        await context.executeSlashCommandsWithOptions(`/world silent=true ${book}`);
        return created.text();
    }, { name, book });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

test('a reply that a lorebook entry came up for is marked; the mark lists the entry, why, and opens it; the mark stays after a reload', async ({ page }) => {
    test.setTimeout(120000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const book = `Lore-${stamp}`;
    const mock = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacterAndBook(page, `Keeper-${stamp}`, book);
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await connectLlamaCpp(page, mock.url);
        await page.waitForTimeout(2500);

        await chatBox(page).fill('Where is the lantern?');
        await page.locator('#send_but').click();
        const reply = page.locator('#chat .mes[mesid="2"]');
        await expect(reply.locator('.mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });

        await expect(reply.locator('.mes_lore')).toBeVisible({ timeout: 10000 });
        await expect(reply.locator('.mes_lore_count')).toHaveText('1');
        await expect(page.locator('#chat .mes[mesid="0"] .mes_lore')).toBeHidden();
        await expect(page.locator('#chat .mes[mesid="1"] .mes_lore')).toBeHidden();

        await reply.locator('.mes_lore').click();
        const panel = page.getByRole('region', { name: 'Worldbuilding entries used for this reply' });
        await expect(panel).toBeVisible();
        const row = panel.locator('li.activation');
        await expect(row).toHaveCount(1);
        await expect(row.locator('.activation-title')).toHaveText('The lantern');
        await expect(row.locator('.activation-book')).toHaveText(book);
        await expect(row.locator('.activation-reason')).toHaveText('“lantern” in message #1');

        await row.locator('.activation-open').click();
        await expect(panel).toBeHidden();
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('The lantern', { timeout: 10000 });
        await expect(page.locator('#Worldbuilding .wb-switch-name')).toHaveText(book);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="2"] .mes_lore')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_lore')).toBeHidden();
    } finally {
        await mock.close();
    }
});

test('the words that brought an entry in are marked where they were written; pointing shows its card and why, a click opens it', async ({ page }) => {
    test.setTimeout(120000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const book = `Marks-${stamp}`;
    const mock = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacterAndBook(page, `Marker-${stamp}`, book);
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await connectLlamaCpp(page, mock.url);
        await page.waitForTimeout(2500);

        await chatBox(page).fill('Where is the old *lantern* kept?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });

        const sent = page.locator('#chat .mes[mesid="1"] .mes_text');
        const marks = sent.locator('.trigger-mark');
        await expect(marks).toHaveCount(1, { timeout: 10000 });
        await expect(marks).toHaveText('lantern');
        await expect(sent.locator('em .trigger-mark')).toHaveCount(1);
        await expect(sent).toHaveText('Where is the old lantern kept?');
        await expect(page.locator('#chat .mes[mesid="2"] .trigger-mark')).toHaveCount(0);
        await expect(marks).toHaveCSS('text-decoration-style', 'dotted');
        await expect(marks).toHaveCSS('text-decoration-line', 'underline');

        await marks.hover();
        const card = page.locator('.wb-chat-card');
        await expect(card).toBeVisible({ timeout: 5000 });
        await expect(card.locator('.wb-entry-title')).toHaveText('The lantern');
        await expect(card.locator('.wb-entry-readonly')).toHaveText('The lantern never goes out.');
        await expect(card.locator('.wb-hover-why')).toHaveText('Activated by “lantern” in the last reply');
        await page.mouse.move(0, 0);
        await expect(card).toBeHidden();

        // Open the entry before the worldbuilding pane has mounted in this page session.
        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(marks).toHaveText('lantern', { timeout: 15000 });
        const opened = page.waitForRequest(request => {
            if (!request.url().endsWith('/api/ui/action')) return false;
            return request.postDataJSON()?.type === 'worldbuilding.navigate' && request.postDataJSON()?.payload?.to?.kind === 'at';
        });
        await marks.click();
        const opening = (await opened).postDataJSON().payload;
        const activated = await page.evaluate(async () => {
            const { chat } = await import('/scripts/chat-state.js');
            return chat[2].extra.activations.entries[0].ref;
        });
        expect(opening.to.book).toBe(activated.book);
        expect(opening.to.entry).toBe(activated.entry);
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('The lantern', { timeout: 10000 });
        await expect(page.locator('#Worldbuilding .wb-switch-name')).toHaveText(book);
        await expect(page.locator('.mes_editor')).toHaveCount(0);
    } finally {
        await mock.close();
    }
});

test('every reply marks the words that brought its entries in, each from its own record, after a reload too', async ({ page }) => {
    test.setTimeout(120000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const book = `Both-${stamp}`;
    const mock = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacterAndBook(page, `Twice-${stamp}`, book, {
            0: { uid: 0, key: ['beacon'], keysecondary: [], comment: 'The beacon', content: 'The beacon is lit.', position: 0, order: 10, disable: false },
            1: { uid: 1, key: ['harbour'], keysecondary: [], comment: 'The harbour', content: 'The harbour is frozen.', position: 0, order: 10, disable: false },
        });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await connectLlamaCpp(page, mock.url);
        await page.waitForTimeout(2500);

        await chatBox(page).fill('Where is the beacon?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });
        await chatBox(page).fill('And what of the harbour?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="4"] .mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });

        const first = page.locator('#chat .mes[mesid="1"] .mes_text .trigger-mark');
        const second = page.locator('#chat .mes[mesid="3"] .mes_text .trigger-mark');
        const marked = async () => {
            await expect(first).toHaveText(['beacon'], { timeout: 15000 });
            await expect(second).toHaveText(['harbour'], { timeout: 15000 });
            await expect(first).toHaveClass(/trigger-mark-earlier/);
            await expect(second).not.toHaveClass(/trigger-mark-earlier/);
            const replies = await page.evaluate(() => {
                // @ts-ignore
                const { chat } = stTest.context();
                return [chat[2].node_id, chat[4].node_id];
            });
            await expect(first).toHaveAttribute('data-lore-reply', replies[0]);
            await expect(second).toHaveAttribute('data-lore-reply', replies[1]);
            await expect(first).toHaveCSS('text-decoration-style', 'dotted');
            await expect(second).toHaveCSS('text-decoration-style', 'dotted');
        };
        await marked();
        await first.hover();
        const card = page.locator('.wb-chat-card');
        await expect(card.locator('.wb-hover-why')).toHaveText('Activated by “beacon” in that reply', { timeout: 5000 });
        // The expanded preview can cover the next message; leave it before pointing at that message.
        await page.mouse.move(0, 0);
        await expect(card).toBeHidden();
        await second.hover();
        await expect(card.locator('.wb-hover-why')).toHaveText('Activated by “harbour” in the last reply', { timeout: 5000 });
        await page.mouse.move(0, 0);
        await expect(card).toBeHidden();

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="4"] .mes_text')).toContainText('It hangs by the door.', { timeout: 15000 });
        await marked();
        await first.hover();
        await expect(card.locator('.wb-entry-readonly')).toHaveText('The beacon is lit.');
        await expect(card.locator('.wb-hover-why')).toHaveText('Activated by “beacon” in that reply');
    } finally {
        await mock.close();
    }
});

test('names and marks stay drawn when the theme or the chat\'s display changes', async ({ page }) => {
    test.setTimeout(120000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const book = `Restyled-${stamp}`;
    const mock = await startLlamaCpp();
    /** @type {string | null} */
    let theme = null;
    try {
        await testSetup.awaitST({ page });
        theme = await page.evaluate(() => String(window['$']('#themes').val()));
        const entry = { uid: 0, key: ['lantern', 'Old Bell'], keysecondary: [], comment: 'The lantern', content: 'The lantern never goes out.', position: 0, order: 10, disable: false, extensions: { names: ['Old Bell'] } };
        const avatar = await createCharacterAndBook(page, `Restyler-${stamp}`, book, { 0: entry });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
        await connectLlamaCpp(page, mock.url);
        await page.waitForTimeout(2500);

        await chatBox(page).fill('Where is the old lantern kept, by Old Bell?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });
        const sent = page.locator('#chat .mes[mesid="1"] .mes_text');
        const drawn = async () => {
            await expect(sent.locator('.trigger-mark')).toHaveText(['lantern', 'Old Bell'], { timeout: 10000 });
            await expect(sent.locator('.chat-name')).toHaveText('Old Bell');
        };
        await drawn();

        await page.evaluate(() => { window['$']('#themes').val('Celestial Macaron').trigger('change'); });
        await expect(page.locator('body')).toHaveClass(/bubblechat/);
        await drawn();

        await page.evaluate(() => { window['$']('#chat_display').val('0').trigger('change'); });
        await expect(page.locator('body')).not.toHaveClass(/bubblechat/);
        await drawn();

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(sent).toContainText('Old Bell', { timeout: 15000 });
        await drawn();
    } finally {
        // The worker's later tests share its settings.
        if (theme !== null) await page.evaluate((name) => { window['$']('#themes').val(name).trigger('change'); }, theme);
        await mock.close();
    }
});

test('an embedded lorebook trigger previews and opens its specific entry', async ({ page }) => {
    test.setTimeout(120000);
    const mock = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        const avatar = await page.evaluate(async () => {
            const { getRequestHeaders } = await import('/scripts/request-headers.js');
            const name = `Embedded-${Date.now()}`;
            const form = new FormData();
            form.set('ch_name', name);
            form.set('first_mes', 'Welcome in.');
            form.set('json_data', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
                name, first_mes: 'Welcome in.', extensions: {},
                character_book: { name: 'Inner book', extensions: {}, entries: [
                    { id: 7, keys: ['glowstone'], comment: 'Embedded lantern', content: 'The embedded lantern never goes out.', enabled: true, insertion_order: 0, extensions: {} },
                ] },
            } }));
            const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            return response.text();
        });
        await openCharacter(page, avatar);
        // The embedded-book command must work before worldbuilding has ever mounted.
        await page.locator('#char-management-dropdown').selectOption({ label: 'View/Edit Embedded Lore' });
        await expect(page.locator('#Worldbuilding .wb-card-name')).toContainText('Embedded lantern');
        // Leave a different book in the drawer before requesting embedded lore again.
        await makeWorld(page, `Previous-${Date.now()}`, { 0: { ...LANTERN, comment: 'Wrong lorebook entry' } });
        await page.locator('#WIDrawerIcon').click();
        await openCharacter(page, avatar);
        let releaseOpening = () => {};
        const release = new Promise(resolve => { releaseOpening = () => resolve(undefined); });
        let openingRequested = () => {};
        const requested = new Promise(resolve => { openingRequested = () => resolve(undefined); });
        const routeOpening = async (route) => {
            const request = route.request().postDataJSON();
            if (request.type === 'worldbuilding.navigate' && request.payload.to.kind === 'character') {
                openingRequested();
                await release;
            }
            await route.continue();
        };
        await page.route('**/api/ui/action', routeOpening);
        try {
            await page.locator('#char-management-dropdown').selectOption({ label: 'View/Edit Embedded Lore' });
            await requested;
            // Even with a delayed response, the old book must stay out of view.
            await expect(page.locator('#Worldbuilding')).toBeHidden();
            releaseOpening();
            await expect(page.locator('#Worldbuilding .wb-card-name')).toHaveText('Embedded lantern');
        } finally {
            releaseOpening();
            await page.unroute('**/api/ui/action', routeOpening);
        }
        await page.locator('#WIDrawerIcon').click();
        await connectLlamaCpp(page, mock.url);
        await chatBox(page).fill('Where is the glowstone?');
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('It hangs by the door.', { timeout: 30000 });
        const mark = page.locator('#chat .mes[mesid="1"] .trigger-mark');
        await expect(mark).toHaveText('glowstone');
        await mark.hover();
        const preview = page.locator('.wb-chat-card');
        await expect(preview.locator('.wb-entry-readonly')).toHaveText('The embedded lantern never goes out.');
        await expect(preview.locator('.wb-hover-why')).toHaveText('Activated by “glowstone” in the last reply');
        await page.mouse.move(0, 0);
        await expect(preview).toBeHidden();
        await mark.click();
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('Embedded lantern');
        await page.locator('#WIDrawerIcon').click();
        await page.locator('#chat .mes[mesid="2"] .mes_lore').click();
        const panel = page.getByRole('region', { name: 'Worldbuilding entries used for this reply' });
        await panel.getByRole('button', { name: 'Embedded lantern', exact: true }).click();
        await expect(panel).toBeHidden();
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('Embedded lantern');
    } finally {
        await mock.close();
    }
});
