import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} book
 */
async function createCharacterAndBook(page, name, book, entry = { uid: 0, key: ['lantern'], keysecondary: [], comment: 'The lantern', content: 'The lantern never goes out.', position: 0, order: 10, disable: false }) {
    await makeWorld(page, book, { 0: entry });
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
async function connectLlamaCpp(page, url) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
    await page.locator('#textgen_type').selectOption('llamacpp');
    await page.locator('#llamacpp_api_url_text').fill(url);
    // @ts-ignore
    await page.evaluate(() => { const field = $('#llamacpp_api_url_text'); if (field.autocomplete('instance')) field.autocomplete('close'); });
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => stTest.context().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
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
        const panel = page.locator('dialog.activations');
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
        await expect(card.locator('.wb-hover-name')).toHaveText('The lantern');
        await expect(card.locator('.wb-hover-text')).toHaveText('The lantern never goes out.');
        await expect(card.locator('.wb-hover-why')).toHaveText('Activated by “lantern” in the last reply');
        await page.mouse.move(0, 0);
        await expect(card).toBeHidden();

        await marks.click();
        await expect(page.locator('#Worldbuilding .wb-entry .wb-entry-name')).toContainText('The lantern', { timeout: 10000 });
        await expect(page.locator('#Worldbuilding .wb-switch-name')).toHaveText(book);
        await expect(page.locator('.mes_editor')).toHaveCount(0);
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
        const avatar = await createCharacterAndBook(page, `Restyler-${stamp}`, book, entry);
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
