import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, connectLlamaCpp, openCharacter } from './llamacpp-mock.js';

// A prompt the server builds fills in its macros as the page would: from the user's settings (global variables, the
// context size, the instruct template) and from what only the page knows, sent with the generation (what is typed,
// which extensions are on, the chat's id).

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
    const description = 'Mood {{getglobalvar::mood}}; ctx {{maxContext}}; ext {{hasExtension::memory}}; gen {{lastGenerationType}}; '
        + '{{if {{getglobalvar::mood}}}}shown{{/if}}; pick {{pick::a::b::c::d::e::f}}.';
    const avatar = await page.evaluate(async (description) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
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

    // What the page fills in for the same text: the server's must agree. Nothing has been generated on the page yet;
    // the server's is the send's own type.
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
