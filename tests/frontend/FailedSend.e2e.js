import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A sent message the server didn't store stays on screen marked as not saved, with a notice that doesn't
// fade, and is kept (also across a reload, where it was) until it is saved again or discarded. A retry
// carries the send's key, so a send the server had stored after all isn't stored twice.

const MODEL = 'failed-send-model';
const REPLY = 'Aye, at dawn.';

function startLlamaCpp() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-fs', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') return json({ content: REPLY, stop: true, model: MODEL, tokens_predicted: 4, tokens_evaluated: 10 });
            if (path === '/health' || path === '/slots') return json({});
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())) });
        });
    });
}

/** @param {import('@playwright/test').Page} page @param {string} name */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/** @param {import('@playwright/test').Page} page @param {string} url */
async function connectLlamaCpp(page, url) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
    await page.locator('#textgen_type').selectOption('llamacpp');
    await page.locator('#llamacpp_api_url_text').fill(url);
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
    await page.evaluate(() => {
        // @ts-ignore
        SillyTavern.getContext().textCompletionSettings.streaming = false;
    });
    // The server reads the backend from the saved settings; let that save land.
    await page.waitForTimeout(2500);
}

/** @param {import('@playwright/test').Page} page */
function chatState(page) {
    return page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().chat.map(m => ({ mes: m.mes, node_id: m.node_id ?? null }));
    });
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function reopen(page, avatar) {
    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
}

/** @param {import('@playwright/test').Page} page @param {string} title */
function notice(page, title) {
    return page.locator('.toast-error', { hasText: title });
}

test.describe('a send the server did not store', () => {
    /** @type {{ url: string, close: () => Promise<void> }} */
    let mock;
    test.beforeAll(async () => { mock = await startLlamaCpp(); });
    test.afterAll(async () => { await mock.close(); });

    test('is kept where it was, survives a reload, and is saved once by "Save it again"', async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `FailedSend-${stamp}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        // The generate request never reaches the server.
        await page.route('**/api/backends/text-completions/generate', route => route.abort('connectionreset'));
        const text = `When do we leave ${stamp}?`;
        await chatBox(page).fill(text);
        await page.locator('#send_but').click();

        await expect(notice(page, 'Message not saved')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(1);
        await expect(page.locator('#chat .mes.failed_send .mes_text')).toContainText(text);
        // A new send is refused until it is saved or discarded.
        await page.unroute('**/api/backends/text-completions/generate');
        await chatBox(page).fill('And then?');
        await page.locator('#send_but').click();
        await expect(page.locator('.toast-error', { hasText: 'isn\'t saved yet' })).toBeVisible();
        await chatBox(page).fill('');

        await reopen(page, avatar);
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(1);
        await expect(page.locator('#chat .mes.failed_send')).toHaveAttribute('mesid', '1');
        await expect(page.locator('#chat .mes.failed_send .mes_text')).toContainText(text);
        // The text lives with the failed send, not also in the box.
        expect(await page.evaluate(() => String($('#send_textarea').val()))).toBe('');

        await notice(page, 'Message not saved').getByRole('button', { name: 'Save it again' }).click();
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(0);
        await expect(notice(page, 'Message not saved')).toHaveCount(0);

        await reopen(page, avatar);
        const chat = await chatState(page);
        expect(chat.map(m => m.mes)).toEqual(['Hello.', text]);
        expect(chat[1].node_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(0);
    });

    test('stored after all, its retry lands on the stored message', async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `FailedSendStored-${stamp}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        // The server stores the message and the reply, but the answer never reaches the page.
        await page.route('**/api/backends/text-completions/generate', async (route) => {
            await route.fetch();
            await route.abort('connectionreset');
        });
        const text = `Stored after all ${stamp}`;
        await chatBox(page).fill(text);
        await page.locator('#send_but').click();
        await expect(notice(page, 'Message not saved')).toBeVisible({ timeout: 15000 });
        await page.unroute('**/api/backends/text-completions/generate');

        await notice(page, 'Message not saved').getByRole('button', { name: 'Save it again' }).click();
        await expect(notice(page, 'Message not saved')).toHaveCount(0);
        // The chat is read again: the message once, with the reply the server stored after it.
        await expect.poll(async () => (await chatState(page)).map(m => m.mes)).toEqual(['Hello.', text, REPLY]);
    });

    test('a reload while it is being sent brings it back, unless the server had stored it', async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `FailedSendReload-${stamp}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        // The request never reaches the server, and the page is reloaded before it settles.
        await page.route('**/api/backends/text-completions/generate', () => new Promise(() => {}));
        const lost = `Lost in flight ${stamp}`;
        await chatBox(page).fill(lost);
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes .mes_text', { hasText: lost })).toHaveCount(1);
        // Left routed through the reload: unrouting first would let the held request through.
        await reopen(page, avatar);
        await page.unroute('**/api/backends/text-completions/generate');
        await expect(page.locator('#chat .mes.failed_send .mes_text')).toContainText(lost);
        await expect(notice(page, 'Message not saved')).toBeVisible();
        await notice(page, 'Message not saved').getByRole('button', { name: 'Save it again' }).click();
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(0);
        await connectLlamaCpp(page, mock.url);

        // The server stores it, but the page is reloaded before hearing so.
        await page.route('**/api/backends/text-completions/generate', async (route) => {
            await route.fetch();
            await new Promise(() => {});
        });
        const stored = `Stored in flight ${stamp}`;
        await chatBox(page).fill(stored);
        await page.locator('#send_but').click();
        await expect.poll(() => page.evaluate(async ({ avatar, stored }) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
            return (await response.json()).messages.some(m => m.mes === stored);
        }, { avatar, stored }), { timeout: 15000 }).toBe(true);
        await reopen(page, avatar);
        await page.unroute('**/api/backends/text-completions/generate');
        await expect(page.locator('#chat .mes .mes_text', { hasText: stored })).toHaveCount(1);
        await expect(page.locator('#chat .mes.failed_send')).toHaveCount(0);
        await expect(notice(page, 'Message not saved')).toHaveCount(0);
        expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('FailedSends:')).length)).toBe(0);
    });

    test('whose place moved on is shown at the end, and can be sent as a reply to what it followed', async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `FailedSendMoved-${stamp}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        await page.route('**/api/backends/text-completions/generate', route => route.abort('connectionreset'));
        const text = `Late message ${stamp}`;
        await chatBox(page).fill(text);
        await page.locator('#send_but').click();
        await expect(notice(page, 'Message not saved')).toBeVisible({ timeout: 15000 });
        await page.unroute('**/api/backends/text-completions/generate');

        // Meanwhile someone else adds a message after the greeting.
        const greetingNode = await page.evaluate(async (avatar) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            const nodeId = await ensureOpeningRow(0);
            const response = await fetch('/api/chats/message/append', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, after_node_id: nodeId, messages: [{ name: 'Other', is_user: true, mes: 'Someone else spoke.', send_date: Date.now(), extra: {} }] }),
            });
            if (!response.ok) throw new Error(`append failed: ${response.status}`);
            return nodeId;
        }, avatar);

        await reopen(page, avatar);
        const moved = notice(page, 'Message not saved');
        await expect(moved).toContainText('no longer the end of this chat');
        await expect(page.locator('#chat .mes.failed_send .failed_send_note')).toContainText('Written after "Hello."');
        expect((await chatState(page)).map(m => m.mes)).toEqual(['Hello.', 'Someone else spoke.', text]);

        await moved.getByRole('button', { name: 'Send as reply to that message' }).click();
        await expect(moved).toHaveCount(0);
        // It is on its own branch now, right after the greeting.
        await expect.poll(async () => (await chatState(page)).map(m => m.mes)).toEqual(['Hello.', text]);
        const chat = await chatState(page);
        expect(chat[0].node_id).toBe(greetingNode);
        expect(chat[1].node_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
