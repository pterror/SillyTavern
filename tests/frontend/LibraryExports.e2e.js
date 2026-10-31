import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('the libraries the page imports', () => {
    test.beforeEach(testSetup.awaitST);

    test('every /lib.js export works', async ({ page }) => {
        const results = await page.evaluate(async () => {
            const lib = await import('/lib.js');
            /** @type {Record<string, () => unknown>} */
            const checks = {
                lodash: () => lib.lodash.isEqual({ a: [1] }, { a: [1] }),
                Fuse: () => new lib.Fuse([{ name: 'forest' }], { keys: ['name'] }).search('forst')[0]?.item.name === 'forest',
                DOMPurify: () => lib.DOMPurify.sanitize('<b onclick="x()">b</b>') === '<b>b</b>',
                hljs: () => lib.hljs.highlight('const a = 1;', { language: 'javascript' }).value.includes('hljs-keyword'),
                localforage: () => typeof lib.localforage.createInstance({ name: 'probe' }).getItem === 'function',
                Handlebars: () => lib.Handlebars.compile('{{a}}!')({ a: 'hi' }) === 'hi!',
                css: () => lib.css.parse('a { color: red; }').stylesheet.rules.length === 1,
                Bowser: () => typeof lib.Bowser.getParser(navigator.userAgent).getBrowserName() === 'string',
                DiffMatchPatch: () => new lib.DiffMatchPatch().diff_main('abc', 'abd').length > 1,
                Readability: () => typeof lib.Readability === 'function' && typeof lib.isProbablyReaderable(document) === 'boolean',
                SVGInject: () => typeof lib.SVGInject === 'function',
                showdown: () => new lib.showdown.Converter().makeHtml('**b**').includes('<strong>b</strong>'),
                Marked: () => String(new lib.Marked().parse('*i*')).includes('<em>i</em>'),
                moment: () => lib.moment('2026-01-02').format('YYYY') === '2026',
                seedrandom: () => lib.seedrandom('seed')() === lib.seedrandom('seed')(),
                Popper: () => typeof lib.Popper.createPopper === 'function',
                droll: () => lib.droll.roll('2d6').total >= 2,
                morphdom: () => {
                    const from = document.createElement('p');
                    lib.morphdom(from, '<p>to</p>');
                    return from.textContent === 'to';
                },
                slideToggle: () => typeof lib.slideToggle === 'function',
                chalk: () => typeof lib.chalk.red('x') === 'string',
                yaml: () => lib.yaml.parse('a: 1').a === 1,
                chevrotain: () => typeof lib.chevrotain.createToken({ name: 'T', pattern: /t/ }) === 'object',
                gzip: () => lib.gzipSync(new Uint8Array([1, 2, 3])).length > 0 && typeof lib.gzip === 'function',
                sha256: () => lib.sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
                default: () => lib.default.lodash === lib.lodash && typeof lib.initLibraryShims === 'function',
            };
            /** @type {Record<string, string>} */
            const failed = {};
            for (const [name, check] of Object.entries(checks)) {
                try {
                    if (check() !== true) failed[name] = 'wrong result';
                } catch (error) {
                    failed[name] = String(error);
                }
            }
            return failed;
        });
        expect(results).toEqual({});
    });

    test('/live-editor-lib.js gives the editor one copy of each CodeMirror package', async ({ page }) => {
        const ok = await page.evaluate(async () => {
            const editor = await import('/live-editor-lib.js');
            const state = editor.state.EditorState.create({ doc: 'a', extensions: [editor.langMarkdown.markdown()] });
            return state.doc.toString() === 'a' && typeof editor.view.EditorView === 'function' && typeof editor.lezerCommon.Tree === 'function';
        });
        expect(ok).toBe(true);
    });
});
