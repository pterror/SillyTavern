import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Generation as upstream extensions see it: a quiet prompt (`/sysgen`) reaches the backend's prompt; CHAT_LOADED
// carries `id` and GROUP_MEMBER_DRAFTED the member's index in `characters`, as upstream emits them; a generation
// that fails shows one toast with the backend's message.

const MODEL = 'upstream-compat-model';
const REPLY = 'Sunny.';

/**
 * A llama.cpp stand-in that records each /completion prompt. `refuse` makes /completion drop the connection, as a
 * backend that isn't running would.
 */
function startLlamaCpp() {
    const state = { prompts: /** @type {string[]} */ ([]), refuse: false };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-uc', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') {
                if (state.refuse) return req.socket.destroy();
                state.prompts.push(String(JSON.parse(body || '{}').prompt ?? ''));
                return json({ content: REPLY, stop: true, model: MODEL, tokens_predicted: 2, tokens_evaluated: 10 });
            }
            if (path === '/health' || path === '/slots') return json({});
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise(done => server.close(() => done())) });
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

/** Records the events an upstream extension listens to, from now on. @param {import('@playwright/test').Page} page */
async function recordEvents(page) {
    await page.evaluate(() => {
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        // @ts-ignore
        window.__chatLoaded = [];
        // @ts-ignore
        window.__drafted = [];
        // @ts-ignore
        eventSource.on(eventTypes.CHAT_LOADED, (event) => window.__chatLoaded.push({ id: event?.detail?.id, avatar: event?.detail?.character?.avatar }));
        // @ts-ignore
        eventSource.on(eventTypes.GROUP_MEMBER_DRAFTED, (chId) => window.__drafted.push(chId));
    });
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

/** @param {import('@playwright/test').Page} page @param {string} url @param {boolean} streaming */
async function connectLlamaCpp(page, url, streaming) {
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
    await page.evaluate((streaming) => {
        // @ts-ignore
        SillyTavern.getContext().textCompletionSettings.streaming = streaming;
    }, streaming);
    // The server reads the backend from the saved settings; let that save land.
    await page.waitForTimeout(2500);
}

function stamp() {
    return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test.describe('generation as upstream extensions see it', () => {
    /** @type {{ url: string, state: { prompts: string[], refuse: boolean }, close: () => Promise<void> }} */
    let mock;
    test.beforeAll(async () => { mock = await startLlamaCpp(); });
    test.afterAll(async () => { await mock.close(); });
    test.beforeEach(() => { mock.state.refuse = false; });

    test('CHAT_LOADED carries the character\'s index as `id`', async ({ page }) => {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `ChatLoaded-${stamp()}`);
        await recordEvents(page);
        await openCharacter(page, avatar);
        // @ts-ignore
        const loaded = await page.evaluate(() => window.__chatLoaded.at(-1));
        // @ts-ignore
        const expected = await page.evaluate(() => SillyTavern.getContext().characterId);
        expect(loaded.avatar).toBe(avatar);
        expect(loaded.id).toBe(expected);
        // @ts-ignore
        expect(await page.evaluate((id) => SillyTavern.getContext().characters[id]?.avatar, loaded.id)).toBe(avatar);
    });

    test('/sysgen sends its instruction to the backend', async ({ page }) => {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `Sysgen-${stamp()}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url, false);
        const before = mock.state.prompts.length;
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/sysgen Describe the weather in one word.');
        });
        await expect.poll(() => mock.state.prompts.length).toBeGreaterThan(before);
        expect(mock.state.prompts.at(-1)).toContain('Describe the weather in one word.');
    });

    test('GROUP_MEMBER_DRAFTED carries the member\'s index in `characters`', async ({ page }) => {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `Drafted-${stamp()}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url, false);
        await recordEvents(page);
        await page.evaluate(async ({ members, name }) => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
            if (!response.ok) throw new Error(`group create failed: ${response.status}`);
            const id = String((await response.json()).id);
            const { groupsStore, openGroupById } = await import('/scripts/group-chats.js');
            await ctx.getCharacters({ silentGroups: true });
            groupsStore.reportCreated(id);
            await openGroupById(id);
            await ctx.generate('normal');
        }, { members: [avatar], name: `DraftedGroup-${stamp()}` });
        // @ts-ignore
        const drafted = await page.evaluate(() => window.__drafted);
        expect(drafted.length).toBeGreaterThan(0);
        expect(typeof drafted[0]).toBe('number');
        // @ts-ignore
        expect(await page.evaluate((id) => SillyTavern.getContext().characters[id]?.avatar, drafted[0])).toBe(avatar);
    });

    for (const streaming of [true, false]) {
        test(`a backend that drops the connection shows one error toast (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Refused-${stamp()}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url, streaming);
            mock.state.refuse = true;
            await page.evaluate(async () => {
                // @ts-ignore
                await SillyTavern.getContext().generate('normal').catch(() => {});
            });
            await expect(page.locator('.toast-error')).toHaveCount(1, { timeout: 10000 });
        });
    }
});
