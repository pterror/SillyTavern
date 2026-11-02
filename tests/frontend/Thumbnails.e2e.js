import zlib from 'node:zlib';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

const STILL = /^\/thumbnail\/[0-9a-f]{64}\.c120x180\.webp$/;

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
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
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
            await SillyTavern.getContext().getCharacters();
        });
        const thumbnail = await page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
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
            await SillyTavern.getContext().getCharacters();
            const { power_user } = await import('/scripts/power-user.js');
            power_user.never_resize_avatars = true;
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
        const before = await page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar);
        const shown = await page.locator(`img[src="${before}"]`).count();
        expect(shown).toBeGreaterThan(0);

        await page.locator('#add_avatar_button').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: solidPng(10, 200, 30) });

        await expect.poll(() => page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar)).not.toBe(before);
        const after = await page.evaluate(async (avatar) => (await import('/script.js')).characterThumbnail(avatar), avatar);
        expect(after).toMatch(STILL);
        await expect(page.locator(`img[src="${before}"]`)).toHaveCount(0);
        await expect(page.locator(`img[src="${after}"]`)).toHaveCount(shown - 1);
        await expect(page.locator('#avatar_load_preview')).toHaveAttribute('src', /^data:image\/png/);
    });

    test('personas and backgrounds are listed with the thumbnails the server sent', async ({ page }) => {
        const personas = await page.evaluate(async () => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
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
        expect(await tile.evaluate(el => el.style.backgroundImage)).toMatch(/^url\("\/thumbnail\/[0-9a-f]{64}\.(f200\.webp|anim)"\)$/);
    });
});
