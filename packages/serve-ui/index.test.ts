import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, expect, test } from 'vite-plus/test';
import { serveUi } from './index.ts';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ui-build-'));
const servers: { close(): void }[] = [];
afterAll(() => {
    for (const server of servers) server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
});

async function start(dev: boolean) {
    const app = express();
    app.use(await serveUi({ outDir, dev }));
    app.use((_request, response) => void response.status(404).send('not the page'));
    const server = app.listen(0);
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('built: the entry the manifest names is served under /ui/, nothing else is', async () => {
    const origin = await start(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(outDir, '.vite/manifest.json'), 'utf8')) as Record<
        string,
        { file: string }
    >;
    const entry = manifest['src/main.tsx'];
    expect(entry).toBeDefined();
    const response = await fetch(`${origin}/ui/${entry?.file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${origin}/elsewhere.js`)).status).toBe(404);
});

test("dev: a module is compiled when asked for, JSX to Solid's h", async () => {
    const origin = await start(true);
    const response = await fetch(`${origin}/ui/test/jsx-fixture.tsx`);
    expect(response.status).toBe(200);
    const code = await response.text();
    expect(code).toMatch(/solid-js_h_jsx-(dev-)?runtime/);
    expect(code).not.toContain('<b>');
    expect((await fetch(`${origin}/elsewhere.js`)).status).toBe(404);
});
