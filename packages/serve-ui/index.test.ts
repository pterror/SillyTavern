import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, expect, test } from 'vite-plus/test';
import { serveUi } from './index.ts';

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ui-build-'));
const servers: { close(): void }[] = [];
const entries: string[] = [];
afterAll(() => {
    for (const server of servers) server.close();
    fs.rmSync(outDir, { recursive: true, force: true });
});

async function start(dev: boolean) {
    const app = express();
    const served = await serveUi({ outDir, dev });
    entries.push(served.entry());
    app.use(served.router);
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
    // The old page imports the new one's `start` from it.
    expect(await response.text()).toMatch(/export\s*\{[^}]*\bstart\b/);
    expect((await fetch(`${origin}/elsewhere.js`)).status).toBe(404);
});

test("dev: a module is compiled when asked for, JSX by Solid's compiler", async () => {
    const origin = await start(true);
    const response = await fetch(`${origin}/ui/test/jsx-fixture.tsx`);
    expect(response.status).toBe(200);
    const code = await response.text();
    expect(code).toMatch(/template\(/);
    // The template is HTML; the JSX itself is gone.
    expect(code).not.toContain('<b>{');
    expect(await (await fetch(`${origin}/ui/entry.js`)).text()).toBe(`export * from '/ui/src/main.tsx';\n`);
    expect((await fetch(`${origin}/elsewhere.js`)).status).toBe(404);
});
