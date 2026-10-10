import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A sent message is stored as the page shows it once sent (macros filled in, its persona, whatever a
// `MESSAGE_SENT` handler changed), and what an extension put on the chat without saving it (a message, a chat
// metadata key) reaches the server with the generation, so a reload shows the same chat.

const MODEL = 'sent-message-model';
const REPLY = 'At dawn.';

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
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-sm', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') return json({ content: REPLY, stop: true, model: MODEL, tokens_predicted: 3, tokens_evaluated: 10 });
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
        const context = SillyTavern.getContext();
        return {
            messages: context.chat.map(m => ({ name: m.name, mes: m.mes, is_user: !!m.is_user, persona: m.persona ?? null, bias: m.extra?.bias ?? null })),
            metadataKey: context.chatMetadata.sent_message_test ?? null,
        };
    });
}

test.describe('a sent message', () => {
    /** @type {{ url: string, close: () => Promise<void> }} */
    let mock;
    test.beforeAll(async () => { mock = await startLlamaCpp(); });
    test.afterAll(async () => { await mock.close(); });

    test('is stored as the page shows it, with what an extension added, and a reload shows the same chat', async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `SentMessage-${stamp}`;
        const avatar = await createCharacter(page, name);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        await page.evaluate(async () => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const { updateMessage } = await import('/scripts/chat-store.js');
            // An extension changing the message once it is sent.
            context.eventSource.on(context.eventTypes.MESSAGE_SENT, (id) => {
                updateMessage(id, { mes: `${context.chat[id].mes} (noted)` });
            });
            // An extension adding a message and a metadata key without saving either.
            const added = { name: 'Narrator', is_user: false, is_system: false, mes: 'Thunder rolls.', send_date: new Date().toISOString(), extra: {} };
            context.chat.push(added);
            context.addOneMessage(added);
            context.chatMetadata.sent_message_test = 'kept';
        });

        await chatBox(page).fill('When do we leave, {{char}}?');
        await page.locator('#send_but').click();
        await expect.poll(async () => (await chatState(page)).messages.map(m => m.mes), { timeout: 15000 })
            .toEqual(['Hello.', 'Thunder rolls.', `When do we leave, ${name}? (noted)`, REPLY]);
        const before = await chatState(page);
        expect(before.messages[2].persona).not.toBeNull();

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        expect(await chatState(page)).toEqual(before);
    });
});
