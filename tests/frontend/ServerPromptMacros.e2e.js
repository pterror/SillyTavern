import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @type {Awaited<ReturnType<typeof startLlamaCpp>>} */
let llama;

test.beforeEach(async ({ page }) => {
    llama = await startLlamaCpp();
    await testSetup.awaitST({ page });
});

test.afterEach(async () => {
    await llama.close();
});

test('a server-built prompt fills in variables, settings and the page\'s facts', async ({ page }) => {
    await connectLlamaCpp(page, llama.url);
    const description = 'Mood {{getglobalvar::mood}}; ctx {{maxContext}}; gen {{lastGenerationType}}; '
        + '{{if {{getglobalvar::mood}}}}shown{{/if}}; pick {{pick::a::b::c::d::e::f}}.';
    const avatar = await page.evaluate(async (description) => {
        // @ts-ignore
        const context = stTest.context();
        context.variables.global.set('mood', 'sunny');
        const { saveSettings } = await import('/script.js');
        await saveSettings();
        const form = new FormData();
        form.set('ch_name', `Macro prompt ${Date.now()}`);
        form.set('first_mes', 'Hello.');
        form.set('description', description);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    }, description);
    await openCharacter(page, avatar);

    const expected = (await page.evaluate(async (description) => {
        const { substituteParams } = await import('/script.js');
        return substituteParams(description);
    }, description)).replace('gen ;', 'gen normal;');
    expect(expected).toContain('Mood sunny');
    expect(expected).toContain('shown');

    await chatBox(page).fill('Hi there');
    await chatBox(page).press('Enter');
    await expect.poll(() => llama.log.filter(entry => entry.url.startsWith('/completion')).length, { timeout: 20000 }).toBeGreaterThan(0);
    const prompt = String(llama.log.find(entry => entry.url.startsWith('/completion')).body.prompt);
    expect(prompt).toContain(expected);
});

test('variables a server-built prompt\'s macros set are kept: the chat\'s stored, the global ones by the page', async ({ page }) => {
    await connectLlamaCpp(page, llama.url);
    const avatar = await page.evaluate(async () => {
        // @ts-ignore
        const context = stTest.context();
        const form = new FormData();
        form.set('ch_name', `Macro setvar ${Date.now()}`);
        form.set('first_mes', 'Hello.');
        form.set('description', 'Weather{{setvar::weather::rainy}} counted {{incvar::turns}}{{setglobalvar::season::autumn}}.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    });
    await openCharacter(page, avatar);
    await chatBox(page).fill('Hi there');
    await chatBox(page).press('Enter');
    await expect.poll(() => llama.log.filter(entry => entry.url.startsWith('/completion')).length, { timeout: 20000 }).toBeGreaterThan(0);
    expect(String(llama.log.find(entry => entry.url.startsWith('/completion')).body.prompt)).toContain('Weather counted 1.');

    const variables = () => page.evaluate(async () => {
        const { chat_metadata } = await import('/scripts/chat-state.js');
        // @ts-ignore
        const season = stTest.context().variables.global.get('season');
        return { weather: chat_metadata.variables?.weather, turns: chat_metadata.variables?.turns, season };
    });
    await expect.poll(variables, { timeout: 10000 }).toEqual({ weather: 'rainy', turns: 1, season: 'autumn' });
    await page.evaluate(async () => {
        const { saveSettings } = await import('/script.js');
        await saveSettings();
    });
    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    await expect.poll(variables, { timeout: 10000 }).toEqual({ weather: 'rainy', turns: 1, season: 'autumn' });
});
