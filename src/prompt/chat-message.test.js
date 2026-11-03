import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import '../fetch-patch.js';
import { Jimp, JimpMime } from '../jimp.js';
import { imageSize } from 'image-size';
import { TokenHandler, Message } from './chat-message.js';

const fakeCountTokens = async (messages) => JSON.stringify(messages).length;

{
    const th = new TokenHandler(fakeCountTokens);
    const n = await th.countAsync({ role: 'system', content: 'hello' }, false);
    assert.equal(n, JSON.stringify({ role: 'system', content: 'hello' }).length);
    assert.deepEqual(Object.keys(th), ['countTokenAsyncFn'], 'a handler counts; what each count is for is the message\'s');
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('system', 'hello world', 'id1', th);
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'hello world');
    assert.equal(msg.identifier, 'id1');
    const expected = JSON.stringify({ role: 'system', content: 'hello world' }).length;
    assert.equal(msg.tokens, expected);
    assert.equal(msg.getTokens(), expected);
}

{
    let called = false;
    const th = new TokenHandler(async (messages, full) => {
        called = true;
        return fakeCountTokens(messages, full);
    });
    const msg = await Message.createAsync('system', '', 'id2', th);
    assert.equal(msg.tokens, 0);
    assert.equal(called, false, 'tokenizer must not be invoked for empty string content');

    const msg2 = await Message.createAsync('user', undefined, 'id3', th);
    assert.equal(msg2.tokens, 0);
    assert.equal(called, false, 'tokenizer must not be invoked for undefined content');
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('', 'content', 'id4', th);
    assert.equal(msg.role, 'system');
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('system', 'hi', 'idN', th);
    const before = msg.tokens;
    await msg.setName('Bob', th);
    assert.equal(msg.name, 'Bob');
    const expected = JSON.stringify({ role: 'system', content: 'hi', name: 'Bob' }).length;
    assert.equal(msg.tokens, expected);
    assert.notEqual(msg.tokens, before);
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('assistant', '', 'idT', th);
    const invocations = [
        { id: 'call_1', name: 'search', parameters: { q: 'x' }, signature: 'sig1', reasoning: '' },
        { id: 'call_2', name: 'lookup', parameters: { y: 1 }, reasoning: 'thinking about it' },
    ];
    await msg.setToolCalls(invocations, true, true, th);
    assert.equal(msg.tool_calls.length, 2);
    assert.deepEqual(msg.tool_calls[0], {
        id: 'call_1', type: 'function', function: { arguments: { q: 'x' }, name: 'search' }, signature: 'sig1',
    });
    assert.deepEqual(msg.tool_calls[1], {
        id: 'call_2', type: 'function', function: { arguments: { y: 1 }, name: 'lookup' },
    });
    assert.equal(msg.reasoning, 'thinking about it', 'first invocation with non-empty reasoning wins as fallback');
    const expectedPayload = {
        role: 'assistant',
        tool_calls: JSON.stringify(msg.tool_calls),
        reasoning: 'thinking about it',
    };
    assert.equal(msg.tokens, JSON.stringify(expectedPayload).length);

    const msg2 = await Message.createAsync('assistant', '', 'idT2', th);
    await msg2.setToolCalls(invocations, false, false, th);
    assert.equal(msg2.tool_calls[0].signature, undefined);
    assert.equal(msg2.reasoning, null);
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('user', 'plain text', 'idA', th);
    const arr = msg.ensureContentIsArray();
    assert.deepEqual(arr, [{ type: 'text', text: 'plain text' }]);
    assert.strictEqual(msg.content, arr);

    const msg2 = new Message('user', [{ type: 'text', text: 'x' }], 'idB');
    const before = msg2.content;
    const arr2 = msg2.ensureContentIsArray();
    assert.strictEqual(arr2, before);
}

async function makeJpegDataUrl(width, height, { noise = false } = {}) {
    const image = new Jimp({ width, height, color: 0xffffffff });
    if (noise) {
        for (let i = 0; i < image.bitmap.data.length; i++) {
            image.bitmap.data[i] = Math.floor(Math.random() * 256);
        }
    }
    const buffer = await image.getBuffer(JimpMime.jpeg, { quality: 90, jpegColorSpace: 'ycbcr' });
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

{
    const th = new TokenHandler(async () => 0);
    const msg = await Message.createAsync('user', undefined, 'imgLow', th);
    const dataUrl = await makeJpegDataUrl(64, 64);
    await msg.addImage(dataUrl, { quality: 'low' });
    assert.equal(msg.tokens, Message.tokensPerImage);
    assert.equal(msg.content.length, 1);
    assert.equal(msg.content[0].type, 'image_url');
    assert.equal(msg.content[0].image_url.detail, 'low');
    assert.ok(msg.content[0].image_url.url.startsWith('data:image/jpeg;base64,'));
}

{
    const th = new TokenHandler(async () => 0);
    const msg = await Message.createAsync('user', undefined, 'imgAuto', th);
    const dataUrl = await makeJpegDataUrl(600, 600);
    await msg.addImage(dataUrl, { quality: 'auto' });
    assert.equal(msg.tokens, 765);

    const msg2 = await Message.createAsync('user', undefined, 'imgAutoSmall', th);
    const smallDataUrl = await makeJpegDataUrl(400, 300);
    await msg2.addImage(smallDataUrl, { quality: 'auto' });
    assert.equal(msg2.tokens, Message.tokensPerImage);
}

{
    const th = new TokenHandler(async () => 0);
    const dataUrl = await makeJpegDataUrl(32, 32);

    const videoMsg = await Message.createAsync('user', undefined, 'vid1', th);
    await videoMsg.addVideo(dataUrl);
    assert.equal(videoMsg.tokens, 263 * 40);
    assert.equal(videoMsg.content.length, 1);
    assert.deepEqual(videoMsg.content[0], { type: 'video_url', video_url: { url: dataUrl, detail: 'auto' } });

    const audioMsg = await Message.createAsync('user', undefined, 'aud1', th);
    await audioMsg.addAudio(dataUrl);
    assert.equal(audioMsg.tokens, 32 * 300);
    assert.equal(audioMsg.content.length, 1);
    assert.deepEqual(audioMsg.content[0], { type: 'audio_url', audio_url: { url: dataUrl } });
}

{
    const th = new TokenHandler(async () => 0);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-chat-message-test-'));
    const userImages = path.join(root, 'user', 'images');
    const charDir = path.join(userImages, 'Alice');
    await fs.mkdir(charDir, { recursive: true });
    const sourceBuffer = Buffer.from((await makeJpegDataUrl(50, 50)).split(',')[1], 'base64');
    await fs.writeFile(path.join(charDir, 'pic.jpg'), sourceBuffer);

    const msg = await Message.createAsync('user', undefined, 'localImg', th);
    await msg.addImage('/user/images/Alice/pic.jpg', { quality: 'low', directories: { userImages } });
    assert.equal(msg.content.length, 1, 'local file was read and pushed');
    assert.equal(msg.tokens, Message.tokensPerImage);
    assert.ok(msg.content[0].image_url.url.startsWith('data:image/jpeg;base64,'));
    const readBack = Buffer.from(msg.content[0].image_url.url.split(',')[1], 'base64');
    assert.deepEqual(readBack, sourceBuffer, 'disk-read bytes round-trip into the data URL unchanged');

    const trav = await Message.createAsync('user', undefined, 'traversal', th);
    await trav.addImage('/user/images/../../../etc/passwd', { quality: 'low', directories: { userImages } });
    assert.equal(trav.content.length, 0, 'traversal attempt must not read or push anything');
    assert.equal(trav.tokens, 0);

    const noDirs = await Message.createAsync('user', undefined, 'noDirs', th);
    await noDirs.addImage('/user/images/Alice/pic.jpg', { quality: 'low' });
    assert.equal(noDirs.content.length, 0);
}

{
    const th = new TokenHandler(async () => 0);
    const msg = await Message.createAsync('user', undefined, 'compress', th);

    const smallDataUrl = await makeJpegDataUrl(40, 40);
    const mislabeled = 'data:image/gif;base64,' + smallDataUrl.split(',')[1];
    const recompressed = await msg.compressImage(mislabeled, {});
    assert.ok(recompressed.startsWith('data:image/jpeg;base64,'), 'non-safe MIME is re-encoded to JPEG');

    const passthrough = await msg.compressImage(smallDataUrl, { chatCompletionSource: 'openai' });
    assert.equal(passthrough, smallDataUrl, 'safe MIME + non-allowlisted source is untouched');

    const bigDataUrl = await makeJpegDataUrl(2200, 1100, { noise: true });
    const bigBytes = Buffer.byteLength(bigDataUrl.split(',')[1], 'base64');
    assert.ok(bigBytes > 2 * 1024 * 1024, 'test fixture must actually exceed the 2MB threshold');
    const resized = await msg.compressImage(bigDataUrl, { chatCompletionSource: 'openrouter' });
    const resizedBuffer = Buffer.from(resized.split(',')[1], 'base64');
    const dims = imageSize(resizedBuffer);
    assert.equal(dims.width, 2048, 'width (the larger side) is capped at maxSide=2048');
    assert.equal(dims.height, 1024, 'height scales down preserving the original 2:1 aspect ratio');

    const untouched = await msg.compressImage(bigDataUrl, { chatCompletionSource: 'openai' });
    assert.equal(untouched, bigDataUrl);
}

console.log('All chat-message.test.js assertions passed.');
