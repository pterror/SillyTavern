import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('live editor library bundle', () => {
    test.beforeEach(testSetup.awaitST);

    test('is served next to lib.js and its packages share one @codemirror/state', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const lib = await import('/live-editor-lib.js');
            const { EditorState } = lib.state;
            const { EditorView } = lib.view;
            const { markdown } = lib.langMarkdown;
            const { history } = lib.commands;
            const parent = document.createElement('div');
            document.body.append(parent);
            // Extensions built by other packages are accepted only if they come from the same @codemirror/state.
            const view = new EditorView({
                state: EditorState.create({ doc: '# hi *there*', extensions: [markdown(), history()] }),
                parent,
            });
            const text = view.state.doc.toString();
            const rendered = parent.querySelector('.cm-content')?.textContent;
            view.destroy();
            parent.remove();
            return { text, rendered, modules: Object.keys(lib).sort() };
        });
        expect(result.text).toBe('# hi *there*');
        expect(result.rendered).toBe('# hi *there*');
        expect(result.modules).toEqual(['autocomplete', 'commands', 'langMarkdown', 'language', 'lezerCommon', 'lezerHighlight', 'lezerMarkdown', 'search', 'state', 'view']);
    });

    test('lib.js still loads, and a copy the browser already has is answered with 304', async ({ page }) => {
        const hasLodash = await page.evaluate(async () => typeof (await import('/lib.js')).lodash === 'function');
        expect(hasLodash).toBe(true);
        for (const file of ['/lib.js', '/live-editor-lib.js']) {
            const first = await page.request.get(file);
            expect(first.status()).toBe(200);
            const etag = first.headers()['etag'];
            expect(etag).toBeTruthy();
            const second = await page.request.get(file, { headers: { 'If-None-Match': etag } });
            expect(second.status()).toBe(304);
        }
        expect((await page.request.get('/not-a-webpack-entry.js')).status()).toBe(404);
    });
});
