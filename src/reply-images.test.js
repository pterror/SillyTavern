import { describe, test, mock } from 'node:test';
import assert from 'node:assert/strict';

/** @type {object[]} */
const saved = [];
mock.module('./endpoints/images.js', {
    namedExports: {
        saveUserImageFile: async (/** @type {any} */ directories, /** @type {any} */ lib, /** @type {any} */ image) => {
            saved.push({ directories, lib, image });
            return { path: `user/images/${image.subFolder}/${image.filename}.${image.format}`, facts: null };
        },
    },
});

const { imagesOfAnswer, noteReplyImages, storeReplyImages } = await import('./reply-images.js');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ';

describe('reply images', () => {
    test('a non-streamed answer gives its images by source', () => {
        const gemini = { responseContent: { parts: [{ text: 'hi' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }, { thought: true, inlineData: { mimeType: 'image/png', data: 'x' } }] } };
        assert.deepEqual(imagesOfAnswer(gemini, { mainApi: 'openai', source: 'makersuite' }), [PNG]);
        const openrouter = { choices: [{ message: { images: [{ type: 'image_url', image_url: { url: JPEG } }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] } }] };
        assert.deepEqual(imagesOfAnswer(openrouter, { mainApi: 'openai', source: 'openrouter' }), [JPEG]);
        assert.deepEqual(imagesOfAnswer(openrouter, { mainApi: 'openai', source: 'custom' }), []);
        assert.deepEqual(imagesOfAnswer(openrouter, { mainApi: 'textgenerationwebui', source: 'openrouter' }), []);
    });

    test('streamed events add their images to the pending reply', () => {
        const pending = {};
        noteReplyImages(pending, { choices: [{ delta: { content: 'a' } }] });
        assert.equal(/** @type {any} */ (pending).replyImages, undefined);
        noteReplyImages(pending, { choices: [{ delta: { images: [{ type: 'image_url', image_url: { url: JPEG } }] } }] });
        noteReplyImages(pending, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] } }] });
        assert.deepEqual(/** @type {any} */ (pending).replyImages, [JPEG, PNG]);
    });

    test('the images are written to the speaker\'s folder and become the reply\'s media, once each', async () => {
        saved.length = 0;
        const pending = {
            directories: { userImages: '/x' }, chat: { store: { lib: 'lib' } }, name2: 'Cara',
            replyImages: [PNG, PNG], answer: {}, finish: { mainApi: 'openai', source: 'openrouter' },
        };
        /** @type {Record<string, any>} */
        const extra = { reasoning: '' };
        await storeReplyImages(pending, extra);
        assert.equal(saved.length, 1);
        assert.equal(/** @type {any} */ (saved[0]).image.subFolder, 'Cara');
        assert.equal(/** @type {any} */ (saved[0]).image.format, 'png');
        assert.deepEqual(extra.media.map((/** @type {any} */ m) => m.type), ['image']);
        assert.equal(extra.inline_image, true);
    });

    test('a continued reply keeps the images it had', async () => {
        saved.length = 0;
        const pending = {
            directories: { userImages: '/x' }, chat: { store: { lib: 'lib' } }, name2: 'Cara', isContinue: true,
            anchorContent: { extra: { media: [{ url: 'user/images/Cara/old.png', type: 'image', source: 'api' }] } },
            replyImages: [JPEG], answer: {}, finish: { mainApi: 'openai', source: 'openrouter' },
        };
        /** @type {Record<string, any>} */
        const extra = {};
        await storeReplyImages(pending, extra);
        assert.deepEqual(extra.media.map((/** @type {any} */ m) => m.url), ['user/images/Cara/old.png', `user/images/Cara/${/** @type {any} */ (saved[0]).image.filename}.jpeg`]);
    });

    test('a reply without images is left as it is', async () => {
        saved.length = 0;
        /** @type {Record<string, any>} */
        const extra = { reasoning: '' };
        await storeReplyImages({ directories: {}, chat: { store: {} }, answer: { data: {} }, finish: { mainApi: 'openai', source: 'openrouter' } }, extra);
        assert.equal(saved.length, 0);
        assert.deepEqual(extra, { reasoning: '' });
    });
});
