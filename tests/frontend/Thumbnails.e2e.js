import zlib from 'node:zlib';
import UPNG from 'upng-js';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

const STILL = /^\/thumbnail\/s[0-9a-f]{64}\.c120x180\.(?:full|\d+-\d+-\d+-\d+)\.webp$/;

/**
 * @param {number} w
 * @param {number} h
 * @param {[number, number, number][]} colors
 */
function movingPng(w, h, colors) {
    const frames = colors.map(([r, g, b]) => {
        const px = new Uint8Array(w * h * 4);
        for (let i = 0; i < w * h; i++) px.set([r, g, b, 255], i * 4);
        return px.buffer;
    });
    return Buffer.from(UPNG.encode(frames, w, h, 0, colors.map(() => 100)));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number, width: number, height: number }} [crop]
 */
async function confirmCrop(page, crop) {
    const popup = page.locator('dialog.popup[open]');
    await expect(popup.locator('.cropper-container')).toBeVisible();
    if (crop) {
        await page.evaluate((crop) => {
            const img = document.querySelector('dialog.popup[open] .popup-crop-image');
            // @ts-ignore
            $(img).cropper('setData', crop);
        }, crop);
    }
    await popup.locator('.popup-button-ok').click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
function solidPng(r, g, b) {
    const crcTable = Array.from({ length: 256 }, (_, n) => {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        return c >>> 0;
    });
    const crc = (/** @type {Buffer} */ buf) => {
        let c = 0xffffffff;
        for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (/** @type {string} */ name, /** @type {Buffer} */ data) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const size = 64;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return (await response.text()).trim();
    }, name);
}

/** @param {import('@playwright/test').Page} page */
async function openBackgrounds(page) {
    const drawer = page.locator('#Backgrounds');
    if (!(await drawer.evaluate(el => el.classList.contains('openDrawer')))) await page.locator('#backgrounds-drawer-toggle').click();
}

/**
 * @param {import('@playwright/test').Page} page
 */
function thumbnailResponses(page) {
    /** @type {{ path: string, status: number }[]} */
    const seen = [];
    page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/thumbnail')) seen.push({ path, status: response.status() });
    });
    return seen;
}

test.describe('thumbnails', () => {
    test.beforeEach(testSetup.awaitST);

    test('the character list shows each avatar at the URL the server sent, one request each, no redirect, in a box sized before it loads', async ({ page }) => {
        const seen = thumbnailResponses(page);
        const avatar = await createCharacter(page, `!Thumb-${Date.now()}`);
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().getCharacters();
        });
        const thumbnail = await page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            return (await (await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) })).json()).thumbnail;
        }, avatar);
        expect(thumbnail).toMatch(STILL);
        await openCharacterManagementDrawer(page);
        const img = page.locator(`#rm_print_characters_block img[src="${thumbnail}"]`).first();
        await expect(img).toBeVisible();
        const box = await img.boundingBox();
        await expect.poll(() => img.evaluate(el => /** @type {HTMLImageElement} */ (el).complete && /** @type {HTMLImageElement} */ (el).naturalWidth)).toBe(120);
        expect(await img.boundingBox()).toEqual(box);
        expect(seen.filter(r => r.path === thumbnail)).toEqual([{ path: thumbnail, status: 200 }]);
        expect(seen.filter(r => r.status >= 300 && r.status < 400)).toEqual([]);
    });

    test('a replaced avatar shows its new image everywhere it was shown, with no reload', async ({ page }) => {
        const avatar = await createCharacter(page, `Replace-${Date.now()}`);
        await openCharacterManagementDrawer(page);
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            await stTest.context().getCharacters();
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
        const before = await page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar);
        const shown = await page.locator(`img[src="${before}"]`).count();
        expect(shown).toBeGreaterThan(0);

        await page.locator('#add_avatar_button').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: solidPng(10, 200, 30) });
        await confirmCrop(page);

        await expect.poll(() => page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar)).not.toBe(before);
        const after = await page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar);
        expect(after).toMatch(STILL);
        await expect(page.locator(`img[src="${before}"]`)).toHaveCount(0);
        await expect(page.locator(`img[src="${after}"]`)).toHaveCount(shown - 1);
        await expect(page.locator('#avatar_load_preview')).toHaveAttribute('src', /^data:image\//);
    });

    test('personas and backgrounds are listed with the thumbnails the server sent', async ({ page }) => {
        const personas = await page.evaluate(async () => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            return (await fetch('/api/avatars/get', { method: 'POST', headers })).json();
        });
        expect(personas.avatars.length).toBeGreaterThan(0);
        for (const avatar of personas.avatars) expect(personas.thumbnails[avatar]).toMatch(STILL);
        const shown = await page.evaluate(async (avatar) => (await import('/scripts/personas.js')).personaThumbnail(avatar), personas.avatars[0]);
        expect(shown).toBe(personas.thumbnails[personas.avatars[0]]);
        expect((await page.request.get(shown)).headers()['cache-control']).toBe('public, max-age=31536000, immutable');

        await openBackgrounds(page);
        const tile = page.locator('#bg_menu_content .bg_example .thumbnail-clipper').first();
        await expect(tile).toBeVisible();
        expect(await tile.evaluate(el => el.style.backgroundImage)).toMatch(/^url\("\/thumbnail\/[sa][0-9a-f]{64}\.f200\.full\.webp"\)$/);
    });

    test('a new crop of the same image shows its new framing where the old one was shown, with no reload', async ({ page }) => {
        const avatar = await createCharacter(page, `Recrop-${Date.now()}`);
        await openCharacter(page, avatar);
        const image = solidPng(200, 100, 30);
        const thumbnail = () => page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar);
        const upload = async (/** @type {{ x: number, y: number, width: number, height: number }} */ crop) => {
            const before = await thumbnail();
            await page.locator('#add_avatar_button').setInputFiles({ name: 'same.png', mimeType: 'image/png', buffer: image });
            await confirmCrop(page, crop);
            await expect.poll(thumbnail).not.toBe(before);
            return thumbnail();
        };
        const first = await upload({ x: 0, y: 0, width: 20, height: 30 });
        expect(first).toMatch(/\.0-0-20-30\.webp$/);
        await expect.poll(() => page.locator(`img[src="${first}"]`).count()).toBeGreaterThan(0);
        const shown = await page.locator(`img[src="${first}"]`).count();
        const second = await upload({ x: 40, y: 30, width: 20, height: 30 });
        expect(second).toMatch(/\.40-30-20-30\.webp$/);
        await expect(page.locator(`img[src="${first}"]`)).toHaveCount(0);
        await expect(page.locator(`img[src="${second}"]`)).toHaveCount(shown);
        expect((await page.request.get(second)).status()).toBe(200);
    });

    test('an animated avatar\'s list thumbnail moves, and is its first frame with animated thumbnails off', async ({ page }) => {
        const name = `!Moving-${Date.now()}`;
        const avatar = await page.evaluate(async ({ name, bytes }) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders({ omitContentType: true });
            const form = new FormData();
            form.set('ch_name', name);
            form.set('avatar', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'moving.png');
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            // @ts-ignore
            await stTest.context().getCharacters();
            return (await response.text()).trim();
        }, { name, bytes: [...movingPng(60, 90, [[250, 0, 0], [0, 250, 0], [0, 0, 250]])] });
        const thumbnail = () => page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const character = await (await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) })).json();
            return (await import('/script.js')).characterThumbnail(character);
        }, avatar);
        const moving = await thumbnail();
        expect(moving).toMatch(/^\/thumbnail\/a[0-9a-f]{64}\./);
        const bytes = await (await page.request.get(moving)).body();
        expect(bytes.includes(Buffer.from('ANIM'))).toBe(true);
        await openCharacterManagementDrawer(page);
        await expect(page.locator(`#rm_print_characters_block img[src="${moving}"]`).first()).toBeVisible();

        await page.locator('#animated_thumbnails').evaluate(el => /** @type {HTMLInputElement} */ (el).click());
        await expect.poll(thumbnail).toMatch(STILL);
        const still = await (await page.request.get(await thumbnail())).body();
        expect(still.includes(Buffer.from('ANIM'))).toBe(false);
        await page.locator('#animated_thumbnails').evaluate(el => /** @type {HTMLInputElement} */ (el).click());
        await expect.poll(thumbnail).toBe(moving);
    });

    test('a chat\'s backgrounds tab shows thumbnails, not the full images', async ({ page }) => {
        const avatar = await createCharacter(page, `ChatBg-${Date.now()}`);
        await openCharacter(page, avatar);
        const drawer = page.locator('#Backgrounds');
        if (!(await drawer.evaluate(el => el.classList.contains('openDrawer')))) await page.locator('#backgrounds-drawer-toggle').click();
        await page.locator('#bg_tabs label.tab-title', { hasText: 'Chat' }).click();
        await page.locator('#add_bg_button').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: solidPng(30, 60, 90) });
        const tile = page.locator('#bg_custom_content .bg_example .thumbnail-clipper').first();
        await expect(tile).toBeVisible();
        await expect.poll(() => tile.evaluate(el => el.style.backgroundImage)).toMatch(/^url\("\/thumbnail\/s[0-9a-f]{64}\.f200\.full\.webp"\)$/);
    });
});
