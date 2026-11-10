import { createRoot } from 'solid-js';
import { afterEach, expect, test } from 'vite-plus/test';
import { NO_LOOK_STYLE } from '@st/protocol/looks';
import type { Looks, ResolvedLook } from '@st/protocol/looks';
import { createClient } from '../src/client.ts';
import { NAME_BASE_CSS, createLookSheet } from '../src/looks.ts';

const look = (color: string, more: Partial<ResolvedLook> = {}): ResolvedLook => ({
    layers: { rest: [{ property: 'color', value: color }] },
    picture: { before: false, after: false, crop: null, image: null },
    note: null,
    fonts: [],
    ...more,
});
const none: ResolvedLook = {
    layers: {},
    picture: { before: false, after: false, crop: null, image: null },
    note: null,
    fonts: [],
};
const looksOf = (things: Record<string, ResolvedLook>): Looks => {
    const out: Looks = { styles: {}, things: {} };
    for (const [thing, style] of Object.entries(things)) {
        const id = style === none ? NO_LOOK_STYLE : JSON.stringify(style);
        out.styles[id] = style;
        out.things[thing] = id;
    }
    return out;
};

const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function sheet() {
    const written: string[] = [];
    const looks = createLookSheet((css) => written.push(css));
    return { looks, written, last: () => written.at(-1) ?? '' };
}

test("a thing's rules come from the newest holder that draws it, and go when none does", async () => {
    const { looks, last } = sheet();
    looks.hold('a', looksOf({ 1: look('red'), 2: look('blue') }));
    await settled();
    expect(last()).toContain('.look-1 { color: red; }');
    expect(last()).toContain('.look-2 { color: blue; }');
    looks.hold('b', looksOf({ 1: look('teal') }));
    await settled();
    expect(last()).toContain('.look-1 { color: teal; }');
    expect(last()).not.toContain('color: red');
    looks.hold('a', looksOf({ 2: look('blue') }));
    await settled();
    expect(last()).toContain('.look-1 { color: teal; }');
    looks.drop('b');
    await settled();
    expect(last()).not.toContain('.look-1 ');
    expect(last()).toContain('.look-2 { color: blue; }');
    looks.drop('a');
    await settled();
    expect(last()).toBe(NAME_BASE_CSS);
});

test('a newer holder that draws a thing with no look takes its older look away', async () => {
    const { looks, last } = sheet();
    looks.hold('chat', looksOf({ 7: look('gold') }));
    looks.hold('looks.drawn', looksOf({ 7: none }));
    await settled();
    expect(last()).not.toContain('.look-7');
});

test('a holder adds what more it draws; the stylesheet is written once per change and only when it changed', async () => {
    const { looks, written, last } = sheet();
    looks.hold('list', looksOf({ 1: look('red') }));
    looks.add('list', looksOf({ 2: look('blue') }));
    await settled();
    expect(written).toHaveLength(1);
    expect(last()).toContain('.look-1 { color: red; }');
    expect(last()).toContain('.look-2 { color: blue; }');
    looks.hold('list', looksOf({ 1: look('red'), 2: look('blue') }));
    await settled();
    expect(written).toHaveLength(1);
});

test('the picture sides and the note are rules on the name box, and fonts come once with their face', async () => {
    const { looks, last } = sheet();
    const face = { family: 'look-font-abc', url: '/fonts/abc.woff2', format: 'woff2' };
    looks.hold(
        'a',
        looksOf({
            1: look('red', {
                picture: { before: true, after: false, crop: null, image: null },
                note: 'the "heir"',
                fonts: [face],
            }),
            2: look('red', { fonts: [face] }),
        }),
    );
    await settled();
    expect(last()).toContain('.look-box-1 > .name-picture-before { display: inline-block; }');
    expect(last()).not.toContain('name-picture-after { display');
    expect(last()).toContain('.look-box-1::after { content: "the \\22 heir\\22 "; }');
    expect(last().match(/@font-face/g)).toHaveLength(1);
});

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

test('the client holds the looks each view carries under its key, patches adding to them', async () => {
    const { looks, last } = sheet();
    const frames = [
        { key: 'v', version: 1, value: { looks: looksOf({ 1: look('red') }) } },
        { key: 'v', version: 2, patch: { looks: looksOf({ 2: look('blue') }) } },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, views: frames }))) as typeof fetch;
    const client = createClient({ headers: () => ({}), looks });
    createRoot(() => client.view('v'));
    await client.send('x', {});
    await settled();
    expect(last()).toContain('.look-1 { color: red; }');
    expect(last()).toContain('.look-2 { color: blue; }');
});
