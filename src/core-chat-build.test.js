import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyMessageTitles, buildCoreChat, finalizeCoreChatMessage } from './core-chat-build.js';

test('buildCoreChat: drops system messages when canUseTools is false', () => {
    const chat = [
        { is_system: true, mes: 'sys' },
        { is_system: false, mes: 'user' },
    ];
    const result = buildCoreChat(chat, { canUseTools: false, isSwipe: false });
    assert.deepEqual(result, [{ is_system: false, mes: 'user' }]);
});

test('buildCoreChat: keeps system messages with tool_invocations array when canUseTools is true', () => {
    const chat = [
        { is_system: true, mes: 'sys-with-tools', extra: { tool_invocations: [{ id: 1 }] } },
        { is_system: false, mes: 'user' },
    ];
    const result = buildCoreChat(chat, { canUseTools: true, isSwipe: false });
    assert.deepEqual(result, chat);
});

test('buildCoreChat: still drops system messages without tool_invocations even when canUseTools is true', () => {
    const chat = [
        { is_system: true, mes: 'sys-no-tools' },
        { is_system: true, mes: 'sys-empty-extra', extra: {} },
        { is_system: true, mes: 'sys-non-array', extra: { tool_invocations: 'nope' } },
        { is_system: false, mes: 'user' },
    ];
    const result = buildCoreChat(chat, { canUseTools: true, isSwipe: false });
    assert.deepEqual(result, [{ is_system: false, mes: 'user' }]);
});

test('buildCoreChat: always keeps non-system messages', () => {
    const chat = [
        { is_system: false, mes: 'a' },
        { is_system: false, mes: 'b' },
    ];
    const result = buildCoreChat(chat, { canUseTools: false, isSwipe: false });
    assert.deepEqual(result, chat);
});

test('buildCoreChat: isSwipe pops the last surviving message, not the last raw message', () => {
    // The true last element of `chat` is a system message that gets filtered out before the pop
    // happens - the pop must remove whatever is now last (the 'b' user message), not the system
    // message, and not blindly assume a fixed position.
    const chat = [
        { is_system: false, mes: 'a' },
        { is_system: false, mes: 'b' },
        { is_system: true, mes: 'trailing-system' },
    ];
    const result = buildCoreChat(chat, { canUseTools: false, isSwipe: true });
    assert.deepEqual(result, [{ is_system: false, mes: 'a' }]);
});

test('applyMessageTitles: no titles returns empty string', () => {
    assert.equal(applyMessageTitles({}), '');
    assert.equal(applyMessageTitles({ extra: {} }), '');
    assert.equal(applyMessageTitles({ extra: { title: 'T' } }), ''); // no append_title
});

test('applyMessageTitles: top-level append_title + title included', () => {
    const result = applyMessageTitles({ extra: { append_title: true, title: 'Hello' } });
    assert.equal(result, '\n\nHello');
});

test('applyMessageTitles: append_title false means title not included even if title is set', () => {
    const result = applyMessageTitles({ extra: { append_title: false, title: 'Hello' } });
    assert.equal(result, '');
});

test('applyMessageTitles: media array entries independently gated on their own append_title + title', () => {
    const chatItem = {
        extra: {
            media: [
                { title: 'Media A', append_title: true },
                { title: 'Media B', append_title: false },
                { title: '', append_title: true },
                { append_title: true },
                { title: 'Media C', append_title: true },
            ],
        },
    };
    const result = applyMessageTitles(chatItem);
    assert.equal(result, '\n\nMedia A\n\nMedia C');
});

test('applyMessageTitles: multiple titles joined with double newline', () => {
    const chatItem = {
        extra: {
            append_title: true,
            title: 'Top',
            media: [
                { title: 'M1', append_title: true },
                { title: 'M2', append_title: true },
            ],
        },
    };
    const result = applyMessageTitles(chatItem);
    assert.equal(result, '\n\nTop\n\nM1\n\nM2');
});

test('applyMessageTitles: top-level title and media titles combined, top-level first', () => {
    const chatItem = {
        extra: {
            append_title: true,
            title: 'TopTitle',
            media: [
                { title: 'MediaTitle', append_title: true },
            ],
        },
    };
    const result = applyMessageTitles(chatItem);
    assert.equal(result, '\n\nTopTitle\n\nMediaTitle');
    assert.ok(result.indexOf('TopTitle') < result.indexOf('MediaTitle'));
});

test('finalizeCoreChatMessage: passes through index, appends titles suffix, preserves other fields', () => {
    const chatItem = {
        is_user: true,
        send_date: '2024-01-01',
        extra: { append_title: true, title: 'Attachment' },
    };
    const result = finalizeCoreChatMessage(chatItem, 3, 'Resolved text');
    assert.deepEqual(result, {
        is_user: true,
        send_date: '2024-01-01',
        extra: { append_title: true, title: 'Attachment' },
        mes: 'Resolved text\n\nAttachment',
        index: 3,
    });
});

test('finalizeCoreChatMessage: mes unchanged (aside from resolvedMessage) when no titles', () => {
    const chatItem = { is_user: false, foo: 'bar' };
    const result = finalizeCoreChatMessage(chatItem, 0, 'Plain resolved text');
    assert.deepEqual(result, {
        is_user: false,
        foo: 'bar',
        mes: 'Plain resolved text',
        index: 0,
    });
});
