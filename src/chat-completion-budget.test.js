import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// JUDGMENT CALL: side-effect import needed BEFORE any Jimp WASM codec is used (encode/decode) -
// Jimp's WASM codecs (@jsquash/*) load their .wasm binary via a `fetch('file://...')` call, which
// Node's own `fetch` doesn't support. In the real running server this is patched once, globally,
// by src/server-main.js's own top-level `import './fetch-patch.js'` before any request-handling
// code (including this module's image helpers) can run. This standalone test file has no such
// entry point, so it imports the patch itself - `src/endpoints/thumbnails.js` (also Jimp-based)
// relies on the exact same global patch already being installed by the time it runs.
import './fetch-patch.js';
import { Jimp, JimpMime } from './jimp.js';
import { imageSize } from 'image-size';
import {
    TokenHandler,
    Message,
    MessageCollection,
    ChatCompletion,
    IdentifierNotFoundError,
    TokenBudgetExceededError,
} from './chat-completion-budget.js';

/** Deterministic fake tokenizer: token count = JSON length of the input. */
const fakeCountTokens = async (messages) => JSON.stringify(messages).length;

// --- TokenHandler ------------------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    assert.deepEqual(th.getCounts(), {
        start_chat: 0, prompt: 0, bias: 0, nudge: 0, jailbreak: 0, impersonate: 0, examples: 0, conversation: 0,
    });

    const n = await th.countAsync({ role: 'system', content: 'hello' }, false, 'prompt');
    assert.equal(n, JSON.stringify({ role: 'system', content: 'hello' }).length);
    assert.equal(th.getCounts().prompt, n);
    assert.equal(th.getTokensForIdentifier('prompt'), n);
    assert.equal(th.getTokensForIdentifier('nonexistent'), 0);

    await th.countAsync({ role: 'user', content: 'x' }, false, 'conversation');
    const total = th.getTotal();
    assert.equal(total, th.getCounts().prompt + th.getCounts().conversation);

    th.uncount(5, 'prompt');
    assert.equal(th.getCounts().prompt, n - 5);

    th.resetCounts();
    assert.equal(th.getTotal(), 0);
    assert.ok(Object.values(th.getCounts()).every((v) => v === 0));

    th.setCounts({ prompt: 42 });
    assert.deepEqual(th.getCounts(), { prompt: 42 });

    // getTotal treats NaN as 0
    th.setCounts({ prompt: 10, bogus: NaN });
    assert.equal(th.getTotal(), 10);
}

// --- Message.createAsync ------------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('system', 'hello world', 'id1', th);
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'hello world');
    assert.equal(msg.identifier, 'id1');
    const expected = JSON.stringify({ role: 'system', content: 'hello world' }).length;
    assert.equal(msg.tokens, expected);
    assert.equal(msg.getTokens(), expected);
    // countAsync with no "type" arg does `counts[undefined] += n`, i.e. undefined += n = NaN,
    // which getTotal() treats as 0 - so the running per-type totals are unaffected by Message
    // token counting (which never passes a "type").
    assert.ok(Number.isNaN(th.getCounts().undefined));
    assert.equal(th.getTotal(), 0);
}

{
    // Empty content = 0 tokens, tokenizer genuinely NOT called.
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
    // Falsy role defaults to 'system'.
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('', 'content', 'id4', th);
    assert.equal(msg.role, 'system');
}

// --- Message.setName / setToolCalls re-counting -------------------------------

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

    // includeSignature = false strips signatures; includeReasoning = false clears reasoning.
    const msg2 = await Message.createAsync('assistant', '', 'idT2', th);
    await msg2.setToolCalls(invocations, false, false, th);
    assert.equal(msg2.tool_calls[0].signature, undefined);
    assert.equal(msg2.reasoning, null);
}

// --- Message.ensureContentIsArray ---------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('user', 'plain text', 'idA', th);
    const arr = msg.ensureContentIsArray();
    assert.deepEqual(arr, [{ type: 'text', text: 'plain text' }]);
    assert.strictEqual(msg.content, arr);

    // Already-array content is left untouched (a fresh array is only built from non-array content).
    const msg2 = new Message('user', [{ type: 'text', text: 'x' }], 'idB');
    const before = msg2.content;
    const arr2 = msg2.ensureContentIsArray();
    assert.strictEqual(arr2, before);
}

// --- MessageCollection.getChat -------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const m1 = await Message.createAsync('system', 'sys text', 'sys1', th);
    const m2 = await Message.createAsync('user', 'user text', 'user1', th);
    await m2.setName('Alice', th);
    const mToolResult = new Message('tool', 'tool result text', 'call_abc');
    mToolResult.tokens = 1;
    const mEmpty = new Message('assistant', '', 'empty1'); // no content, no tool_calls -> skipped
    const mWithToolCalls = new Message('assistant', '', 'asst1');
    await mWithToolCalls.setToolCalls([{ id: 'c1', name: 'f', parameters: {} }], false, false, th);

    const coll = new MessageCollection('root', m1, m2, mToolResult, mEmpty, mWithToolCalls);
    const chat = coll.getChat();

    assert.equal(chat.length, 4, 'the no-content/no-tool_calls message is skipped');
    assert.deepEqual(chat[0], { role: 'system', content: 'sys text' });
    assert.deepEqual(chat[1], { role: 'user', content: 'user text', name: 'Alice' });
    assert.deepEqual(chat[2], { role: 'tool', content: 'tool result text', tool_call_id: 'call_abc' });
    assert.equal(chat[3].role, 'assistant');
    assert.ok(Array.isArray(chat[3].tool_calls));
    assert.equal(chat[3].content, '');

    assert.equal(coll.getCollection().length, 5);
    assert.equal(coll.getItemByIdentifier('user1'), m2);
    assert.equal(coll.getItemByIdentifier('missing'), undefined);
    assert.equal(coll.hasItemWithIdentifier('sys1'), true);
    assert.equal(coll.hasItemWithIdentifier('missing'), false);

    const expectedTokens = [m1, m2, mToolResult, mEmpty, mWithToolCalls].reduce((a, m) => a + m.getTokens(), 0);
    assert.equal(coll.getTokens(), expectedTokens);
}

// --- MessageCollection.flatten (nested) ---------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const a = await Message.createAsync('system', 'a', 'a', th);
    const b = await Message.createAsync('system', 'b', 'b', th);
    const c = await Message.createAsync('system', 'c', 'c', th);
    const inner = new MessageCollection('inner', b, c);
    const outer = new MessageCollection('outer', a, inner);

    const flat = outer.flatten();
    assert.deepEqual(flat, [a, b, c]);
    assert.equal(outer.getTokens(), a.getTokens() + inner.getTokens());
    assert.equal(inner.getTokens(), b.getTokens() + c.getTokens());
}

{
    // Constructor validation: only Message/MessageCollection instances allowed.
    assert.throws(() => new MessageCollection('bad', { role: 'user', content: 'x' }));
}

// --- ChatCompletion.add: budget check success/failure --------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const msg = await Message.createAsync('system', 'short', 'sys', th);
    cc.setTokenBudget(1000, 0);
    const coll = new MessageCollection('block1', msg);

    cc.add(coll);
    assert.equal(cc.has('block1'), true);
    assert.equal(cc.tokenBudget, 1000 - coll.getTokens());
}

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const msg = await Message.createAsync('system', 'x'.repeat(100), 'sys', th);
    cc.setTokenBudget(5, 0); // budget too small
    const coll = new MessageCollection('block1', msg);

    assert.throws(() => cc.add(coll), TokenBudgetExceededError);
    assert.equal(cc.has('block1'), false, 'failed add must not have inserted anything');
}

{
    // add() with non-MessageCollection throws a plain Error (not a custom class).
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    assert.throws(() => cc.add({ identifier: 'x', getTokens: () => 0 }), (err) => {
        return err instanceof Error && !(err instanceof TokenBudgetExceededError) && !(err instanceof IdentifierNotFoundError);
    });
}

// --- ChatCompletion.insert / insertAtStart / insertAtEnd ------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    cc.add(new MessageCollection('convo'));

    const m1 = await Message.createAsync('user', 'first', 'u1', th);
    const m2 = await Message.createAsync('user', 'second', 'u2', th);
    cc.insertAtEnd(m1, 'convo');
    cc.insertAtStart(m2, 'convo');

    const convoColl = cc.messages.getItemByIdentifier('convo');
    assert.deepEqual(convoColl.getCollection(), [m2, m1]);

    const budgetAfterInserts = 1000 - m1.getTokens() - m2.getTokens();
    assert.equal(cc.tokenBudget, budgetAfterInserts);

    // IdentifierNotFoundError when the target collection doesn't exist.
    const m3 = await Message.createAsync('user', 'third', 'u3', th);
    assert.throws(() => cc.insert(m3, 'nonexistent-block'), IdentifierNotFoundError);

    // Message with no content and no tool_calls is skipped entirely - no throw, no budget change.
    const budgetBefore = cc.tokenBudget;
    const emptyMsg = new Message('user', '', 'u4');
    cc.insert(emptyMsg, 'convo');
    assert.equal(cc.tokenBudget, budgetBefore, 'budget unchanged for skipped empty-content insert');
    assert.equal(convoColl.getCollection().length, 2, 'empty message was not actually inserted');
}

// --- canAfford / canAffordAll --------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(35, 0);
    const small = await Message.createAsync('user', 'hi', 'a', th); // 30 tokens
    const big = await Message.createAsync('user', 'x'.repeat(50), 'b', th); // 78 tokens

    assert.equal(small.getTokens(), 30);
    assert.equal(big.getTokens(), 78);
    assert.equal(cc.canAfford(small), true, '35 - 30 >= 0');
    assert.equal(cc.canAfford(big), false, '35 - 78 < 0');
    assert.equal(cc.canAffordAll([small, small]), false, '35 - 60 < 0');
    assert.equal(cc.canAffordAll([small, big]), false);
}

// --- ChatCompletion.getChat full flattening ------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(10000, 0);

    const sys = await Message.createAsync('system', 'system prompt', 'sysPrompt', th);
    cc.add(new MessageCollection('systemBlock', sys));

    const u1 = await Message.createAsync('user', 'hello', 'msg1', th);
    const a1 = await Message.createAsync('assistant', 'hi there', 'msg2', th);
    const convo = new MessageCollection('conversation', u1, a1);
    cc.add(convo);

    // A collection nested INSIDE another MessageCollection is NOT recursed into by
    // MessageCollection.getChat() (it only checks `message.content || message.tool_calls` on each
    // direct member, and a MessageCollection has neither) - only ChatCompletion.getChat()'s own
    // top-level loop recurses one level via `instanceof MessageCollection`. This matches the
    // client's real (non-recursive, non-shared) implementations exactly; verified here by nesting
    // a tool-result collection inside `convo` and confirming it is silently skipped.
    const nestedTool = new Message('tool', 'tool output', 'toolcall1');
    nestedTool.tokens = 3;
    convo.add(new MessageCollection('toolResults', nestedTool));

    // A second TOP-LEVEL collection, by contrast, IS picked up by ChatCompletion.getChat().
    const toolBlock = new Message('tool', 'top-level tool output', 'toolcall2');
    toolBlock.tokens = 3;
    cc.add(new MessageCollection('toolBlock', toolBlock));

    const chat = cc.getChat();
    assert.deepEqual(chat, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'tool', content: 'top-level tool output', tool_call_id: 'toolcall2' },
    ]);
}

// --- squashSystemMessages -------------------------------------------------------

{
    // Consecutive squashable system messages get merged.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(100000, 0);
    const s1 = await Message.createAsync('system', 'part one', 'sysA', th);
    const s2 = await Message.createAsync('system', 'part two', 'sysB', th);
    const u1 = await Message.createAsync('user', 'hi', 'userMsg', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(u1);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    assert.equal(result.length, 2);
    assert.equal(result[0].content, 'part one\npart two');
    assert.equal(result[0].tokens, JSON.stringify({ role: 'system', content: 'part one\npart two' }).length);
    assert.equal(result[1], u1);
}

{
    // excludeList identifiers are never squashed together with neighbors.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'alpha', 'newMainChat', th);
    const s2 = await Message.createAsync('system', 'beta', 'newChat', th);
    const s3 = await Message.createAsync('system', 'gamma', 'groupNudge', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(s3);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    assert.equal(result.length, 3, 'excludeList identifiers stay separate');
    assert.deepEqual(result.map((m) => m.content), ['alpha', 'beta', 'gamma']);
}

{
    // Named system messages are never squashed (with each other or with unnamed neighbors).
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'unnamed one', 'sysX', th);
    const s2 = await Message.createAsync('system', 'named', 'sysY', th);
    await s2.setName('Narrator', th);
    const s3 = await Message.createAsync('system', 'unnamed two', 'sysZ', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(s3);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    // s1 alone, s2 (named) alone, s3 alone - none squash across the named message.
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((m) => m.content), ['unnamed one', 'named', 'unnamed two']);
}

{
    // Empty-content system messages are dropped entirely.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'kept before', 'sysK1', th);
    const empty = new Message('system', '', 'sysEmpty');
    const s2 = await Message.createAsync('system', 'kept after', 'sysK2', th);
    cc.messages.add(s1);
    cc.messages.add(empty);
    cc.messages.add(s2);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    // empty message dropped; the two real ones squash together since it's never seen as "lastMessage"
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'kept before\nkept after');
}

// --- reserveBudget / freeBudget / removeLastFrom round-trip ---------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    const initialBudget = cc.tokenBudget;

    const msg = await Message.createAsync('user', 'reserve me', 'r1', th);
    cc.reserveBudget(msg);
    assert.equal(cc.tokenBudget, initialBudget - msg.getTokens());
    cc.freeBudget(msg);
    assert.equal(cc.tokenBudget, initialBudget);

    // reserveBudget also accepts a raw number.
    cc.reserveBudget(50);
    assert.equal(cc.tokenBudget, initialBudget - 50);
    cc.increaseTokenBudgetBy(50);
    assert.equal(cc.tokenBudget, initialBudget);

    // removeLastFrom round-trips the budget for insert/remove.
    cc.add(new MessageCollection('block'));
    const before = cc.tokenBudget;
    const inserted = await Message.createAsync('user', 'to be removed', 'ins1', th);
    cc.insertAtEnd(inserted, 'block');
    assert.equal(cc.tokenBudget, before - inserted.getTokens());
    cc.removeLastFrom('block');
    assert.equal(cc.tokenBudget, before, 'budget restored after removing the message that was inserted');

    // removeLastFrom on an already-empty collection: no-op, no throw.
    cc.removeLastFrom('block');
    assert.equal(cc.tokenBudget, before);
}

// --- Message.addImage / addVideo / addAudio (multimodal port) ------------------

/** Builds a real JPEG data URL of the given dimensions via Jimp (solid color, no noise needed for
 *  most tests - only the compressImage-threshold test below needs incompressible noise). */
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
    // (a) addImage, quality='low', data-URL input -> exactly tokensPerImage (85) tokens added,
    // correct content entry shape.
    const th = new TokenHandler(async () => 0); // don't let the base "hi" content contribute tokens
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
    // (b) addImage, quality='auto', real known-dimension image -> tokens computed via the tile
    // formula match a hand-computed expected value.
    // 600x600: min=600, scale=2048/600, scaledW=scaledH=round(600*2048/600)=2048,
    // finalScale=768/2048, finalW=finalH=round(2048*768/2048)=768,
    // squares=ceil(768/512)^2=2*2=4, tokens=4*170+85=765.
    const th = new TokenHandler(async () => 0);
    const msg = await Message.createAsync('user', undefined, 'imgAuto', th);
    const dataUrl = await makeJpegDataUrl(600, 600);
    await msg.addImage(dataUrl, { quality: 'auto' });
    assert.equal(msg.tokens, 765);

    // Small (<=512x512) image with quality='auto' short-circuits to tokensPerImage.
    const msg2 = await Message.createAsync('user', undefined, 'imgAutoSmall', th);
    const smallDataUrl = await makeJpegDataUrl(400, 300);
    await msg2.addImage(smallDataUrl, { quality: 'auto' });
    assert.equal(msg2.tokens, Message.tokensPerImage);
}

{
    // (c) addVideo/addAudio, data-URL input -> correct content entry shape and fallback token
    // estimate applied (263*40 for video, 32*300 for audio) since no duration prober exists.
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
    // (d) local-file-path input, resolved against a real temp directories.userImages fixture ->
    // confirms the fs-based read path works and produces a valid data URL in the pushed content
    // entry, and that path traversal is blocked.
    const th = new TokenHandler(async () => 0);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-chat-completion-budget-test-'));
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

    // Path traversal is blocked: nothing is pushed, no tokens added.
    const trav = await Message.createAsync('user', undefined, 'traversal', th);
    await trav.addImage('/user/images/../../../etc/passwd', { quality: 'low', directories: { userImages } });
    assert.equal(trav.content.length, 0, 'traversal attempt must not read or push anything');
    assert.equal(trav.tokens, 0);

    // Missing directories option -> resolution fails gracefully (no throw), nothing pushed.
    const noDirs = await Message.createAsync('user', undefined, 'noDirs', th);
    await noDirs.addImage('/user/images/Alice/pic.jpg', { quality: 'low' });
    assert.equal(noDirs.content.length, 0);
}

{
    // (e) compressImage's actual resize/re-encode behavior with real oversized/wrong-format test
    // images.
    const th = new TokenHandler(async () => 0);
    const msg = await Message.createAsync('user', undefined, 'compress', th);

    // Wrong-format path: a non-"safe" MIME type (declared as image/gif here, though the bytes are
    // real JPEG bytes - compressImage only inspects the declared MIME prefix, matching the client)
    // is unconditionally re-encoded to JPEG, regardless of size.
    const smallDataUrl = await makeJpegDataUrl(40, 40);
    const mislabeled = 'data:image/gif;base64,' + smallDataUrl.split(',')[1];
    const recompressed = await msg.compressImage(mislabeled, {});
    assert.ok(recompressed.startsWith('data:image/jpeg;base64,'), 'non-safe MIME is re-encoded to JPEG');

    // Safe MIME + under threshold: passed through unchanged (no source in the compress-allowlist).
    const passthrough = await msg.compressImage(smallDataUrl, { chatCompletionSource: 'openai' });
    assert.equal(passthrough, smallDataUrl, 'safe MIME + non-allowlisted source is untouched');

    // Oversized + allowlisted source: resized down to fit maxSide=2048, preserving aspect ratio.
    // Noise is required so the JPEG doesn't compress away below the 2MB threshold.
    const bigDataUrl = await makeJpegDataUrl(2200, 1100, { noise: true });
    const bigBytes = Buffer.byteLength(bigDataUrl.split(',')[1], 'base64');
    assert.ok(bigBytes > 2 * 1024 * 1024, 'test fixture must actually exceed the 2MB threshold');
    const resized = await msg.compressImage(bigDataUrl, { chatCompletionSource: 'openrouter' });
    const resizedBuffer = Buffer.from(resized.split(',')[1], 'base64');
    const dims = imageSize(resizedBuffer);
    assert.equal(dims.width, 2048, 'width (the larger side) is capped at maxSide=2048');
    assert.equal(dims.height, 1024, 'height scales down preserving the original 2:1 aspect ratio');

    // Non-allowlisted source with the same oversized, safe-MIME image is left untouched.
    const untouched = await msg.compressImage(bigDataUrl, { chatCompletionSource: 'openai' });
    assert.equal(untouched, bigDataUrl);
}

console.log('All chat-completion-budget.test.js assertions passed.');
