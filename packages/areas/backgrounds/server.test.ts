import type { BackgroundsView, ChatBackgroundsView } from './protocol.ts';
import { expect, test } from 'vite-plus/test';
import { backgroundsArea, bestTitle, refOfCss } from './server.ts';
import type { ImageThumbnails, Ports, StoredOptions, SystemFile } from './server.ts';
import type { ActionContext, ActionResult, User } from '@st/server-ui';

const user: User = { handle: 'u', directories: { root: '/u' } };

function world(
    files: Partial<SystemFile>[],
    options: StoredOptions = {},
    chat: { list: string[]; locked: string | null } | null = { list: [], locked: null },
    images: Record<string, ImageThumbnails> = {},
) {
    const state = {
        files: files.map((f) => ({
            animated: false,
            color: null,
            aspect: null,
            added: null,
            folders: [],
            thumbnail: null,
            thumbnail_still: null,
            file: '',
            ...f,
        })),
        folders: [] as { id: string; name: string; cover: string | null }[],
        options: { ...options },
        chat,
        deletedImages: [] as string[],
    };
    const ports: Ports = {
        files: {
            list: async () => state.files,
            folders: async () => state.folders,
            save: async (_u, upload) => {
                state.files.push({ ...state.files[0]!, file: upload.name, folders: [] });
                return upload.name;
            },
            copyIn: async (_u, _path, name) => {
                state.files.push({ ...state.files[0]!, file: name, folders: [] });
                return name;
            },
            rename: async (_u, file, to) => {
                const found = state.files.find((f) => f.file === file);
                if (!found || state.files.some((f) => f.file === to)) return false;
                found.file = to;
                return true;
            },
            remove: async (_u, file) => void (state.files = state.files.filter((f) => f.file !== file)),
            createFolder: async (_u, name) =>
                void state.folders.push({ id: `f${state.folders.length}`, name, cover: null }),
            renameFolder: async () => {},
            deleteFolder: async () => {},
            setCover: async (_u, id, file) => {
                for (const f of state.folders) if (f.id === id) f.cover = file;
            },
            addToFolder: async (_u, id, names) => {
                for (const f of state.files) if (names.includes(f.file)) f.folders = [...f.folders, id];
            },
            removeFromFolder: async () => {},
            setFolders: async () => {},
        },
        chat: {
            read: async () => state.chat,
            write: async (_c, change) => {
                if (!state.chat) throw new Error('no chat');
                state.chat = {
                    ...state.chat,
                    ...change,
                    locked: change.locked === undefined ? state.chat.locked : change.locked,
                };
            },
            saveImage: async (_c, upload) => `user/images/Cara/${upload.name}`,
            deleteImage: async (_c, path) => void state.deletedImages.push(path),
            images: async (_c, paths) => Object.fromEntries(paths.flatMap((p) => (images[p] ? [[p, images[p]]] : []))),
        },
        options: { read: async () => state.options, write: async (_u, next) => void (state.options = next) },
    };
    const area = backgroundsArea(ports);
    const context: ActionContext = { user, session: 's', chat: { tree: '1' }, upload: null };
    const read = () => area.views['backgrounds']!(context) as Promise<BackgroundsView>;
    const readChat = () => area.views['backgrounds.chat']!(context) as Promise<ChatBackgroundsView>;
    const view = async () => ({ ...(await read()), ...(await readChat()) });
    const act = (type: string, payload: unknown, upload: ActionContext['upload'] = null): Promise<ActionResult> =>
        area.actions[type]!({ ...context, upload }, payload);
    return { state, view, act };
}

test("picking a system background makes it the user's, shown behind the chat", async () => {
    const w = world([{ file: 'a.png' }, { file: 'b.png' }]);
    expect(await w.act('backgrounds.select', { file: 'b.png', chat: false, forUser: false })).toEqual({
        changed: ['backgrounds', 'backgrounds.chat'],
    });
    const view = await w.view();
    expect(view.selected).toEqual({ file: 'b.png', chat: false });
    expect(view.shown.url).toBe('backgrounds/b.png');
    expect(w.state.options).toMatchObject({ name: 'b.png', url: 'url("backgrounds/b.png")' });
});

test("with the chat locked, a pick changes the lock; forUser changes the user's instead", async () => {
    const w = world(
        [{ file: 'a.png' }, { file: 'b.png' }],
        { name: 'a.png' },
        { list: [], locked: 'url("backgrounds/a.png")' },
    );
    await w.act('backgrounds.select', { file: 'b.png', chat: false, forUser: false });
    expect(w.state.chat?.locked).toBe('url("backgrounds/b.png")');
    expect(w.state.options.name).toBe('a.png');
    await w.act('backgrounds.select', { file: 'a.png', chat: false, forUser: true });
    expect((await w.view()).shown.url).toBe('backgrounds/b.png');
    expect(w.state.options.name).toBe('a.png');
});

test("a chat's own background always becomes the lock, and the lock shows over the user's", async () => {
    const w = world([{ file: 'a.png' }], { name: 'a.png' }, { list: ['user/images/Cara/x y.png'], locked: null });
    await w.act('backgrounds.select', { file: 'user/images/Cara/x y.png', chat: true, forUser: true });
    const view = await w.view();
    expect(view.chat?.locked).toEqual({ file: 'user/images/Cara/x y.png', chat: true });
    expect(view.shown.url).toBe('user/images/Cara/x%20y.png');
    expect(view.selected.file).toBe('a.png');
    await w.act('backgrounds.unlock', {});
    expect((await w.view()).shown.url).toBe('backgrounds/a.png');
});

test("locking with no background named locks the user's", async () => {
    const w = world([{ file: 'a.png' }], { name: 'a.png' });
    await w.act('backgrounds.lock', { background: null });
    expect((await w.view()).chat?.locked).toEqual({ file: 'a.png', chat: false });
});

test("with no chat open, the chat's actions are refused and the view has no chat part", async () => {
    const w = world([{ file: 'a.png' }], {}, null);
    expect(await w.act('backgrounds.lock', { background: null })).toMatchObject({ refused: expect.any(String) });
    expect(
        await w.act(
            'backgrounds.upload',
            { chat: true },
            { path: '/tmp/x', name: 'x.png', type: 'image/png', size: 1 },
        ),
    ).toMatchObject({ refused: expect.any(String) });
    expect((await w.view()).chat).toBeNull();
});

test("an upload becomes a system background and the user's, or one of the chat's", async () => {
    const w = world([{ file: 'a.png' }]);
    const upload = { path: '/tmp/x', name: 'new.png', type: 'image/png', size: 1 };
    await w.act('backgrounds.upload', { chat: false }, upload);
    expect((await w.view()).selected.file).toBe('new.png');
    await w.act('backgrounds.upload', { chat: true }, upload);
    expect(w.state.chat?.list).toEqual(['user/images/Cara/new.png']);
});

test("deleting the user's background selects the next one in the list, else the one before", async () => {
    const w = world([{ file: 'a.png' }, { file: 'b.png' }, { file: 'c.png' }], { name: 'b.png' });
    await w.act('backgrounds.delete', { file: 'b.png', chat: false, deleteFile: false });
    expect(w.state.options.name).toBe('c.png');
    await w.act('backgrounds.delete', { file: 'c.png', chat: false, deleteFile: false });
    expect(w.state.options.name).toBe('a.png');
});

test('deleting a chat background takes it off the list (and its file, when asked) and unlocks it', async () => {
    const path = 'user/images/Cara/x.png';
    const w = world([{ file: 'a.png' }], {}, { list: [path], locked: `url("${path}")` });
    await w.act('backgrounds.delete', { file: path, chat: true, deleteFile: true });
    expect(w.state.chat).toEqual({ list: [], locked: null });
    expect(w.state.deletedImages).toEqual([path]);
});

test("renaming keeps the extension and follows the user's choice; a taken name is refused", async () => {
    const w = world([{ file: 'a.png' }, { file: 'b.png' }], { name: 'a.png' });
    await w.act('backgrounds.rename', { file: 'a.png', name: 'forest' });
    expect(w.state.options.name).toBe('forest.png');
    expect(await w.act('backgrounds.rename', { file: 'forest.png', name: 'b' })).toMatchObject({
        refused: expect.any(String),
    });
});

test('an image made elsewhere is added to the chat and locked', async () => {
    const w = world([{ file: 'a.png' }]);
    await w.act('backgrounds.addToChat', { file: 'user/images/Cara/gen.png' });
    expect(w.state.chat).toEqual({ list: ['user/images/Cara/gen.png'], locked: 'url("user/images/Cara/gen.png")' });
});

test("sorting: by title either way, by age either way (a chat's by the order it added them)", async () => {
    const w = world(
        [
            { file: 'b.png', added: 1 },
            { file: 'A.png', added: 3 },
            { file: 'c.png', added: 2 },
        ],
        {},
        { list: ['user/images/x/2.png', 'user/images/x/1.png'], locked: null },
    );
    const order = async (sortOrder: string) => {
        await w.act('backgrounds.options', { sortOrder });
        const view = await w.view();
        return [view.system.map((b) => b.title).join(','), view.chat?.backgrounds.map((b) => b.title).join(',')];
    };
    expect(await order('az')).toEqual(['A,b,c', '1,2']);
    expect(await order('za')).toEqual(['c,b,A', '2,1']);
    expect(await order('oldest')).toEqual(['b,c,A', '2,1']);
    expect(await order('newest')).toEqual(['A,c,b', '1,2']);
});

test('options from storage are made valid: unknown values fall back, columns are kept in range', async () => {
    const w = world([{ file: 'a.png' }], { fitting: 'sideways', sortOrder: 'random', thumbnailColumns: 40 });
    expect((await w.view()).options).toEqual({
        fitting: 'classic',
        animatedThumbnails: true,
        sortOrder: 'az',
        columns: 8,
    });
    expect((await world([{ file: 'a.png' }]).view()).options.columns).toBeNull();
});

test("an animated background's thumbnail moves unless animated thumbnails are off, when it is the first frame", async () => {
    const w = world([
        {
            file: 'loop.gif',
            animated: true,
            thumbnail: '/thumbnail/a1.f200.full.webp',
            thumbnail_still: '/thumbnail/s1.f200.full.webp',
        },
    ]);
    expect((await w.view()).system[0]?.thumbnail).toBe('/thumbnail/a1.f200.full.webp');
    await w.act('backgrounds.options', { animatedThumbnails: false });
    expect((await w.view()).system[0]?.thumbnail).toBe('/thumbnail/s1.f200.full.webp');
});

test("a chat's backgrounds show the thumbnails the server keeps for them, not their full images", async () => {
    const path = 'user/images/Cara/loop.gif';
    const w = world(
        [{ file: 'a.png' }],
        {},
        { list: [path], locked: null },
        {
            [path]: {
                thumbnail: '/thumbnail/a2.f200.full.webp',
                thumbnail_still: '/thumbnail/s2.f200.full.webp',
                animated: true,
            },
        },
    );
    const tile = (await w.view()).chat?.backgrounds[0];
    expect(tile).toMatchObject({ thumbnail: '/thumbnail/a2.f200.full.webp', animated: true, url: path });
    await w.act('backgrounds.options', { animatedThumbnails: false });
    expect((await w.view()).chat?.backgrounds[0]?.thumbnail).toBe('/thumbnail/s2.f200.full.webp');
});

test("a folder's cover is its cover file's thumbnail, else its first member's", async () => {
    const w = world([
        { file: 'a.png', folders: ['f'], thumbnail: '/thumbnail/a.f200.webp' },
        { file: 'b.png', folders: ['f'], thumbnail: '/thumbnail/b.f200.webp' },
    ]);
    await w.act('backgrounds.folders.create', { name: 'F' });
    const id = (await w.view()).folders[0]?.id ?? '';
    await w.act('backgrounds.folders.add', { files: ['a.png', 'b.png'], folders: [id] });
    expect((await w.view()).folders[0]?.cover).toBe('/thumbnail/a.f200.webp');
    await w.act('backgrounds.folders.cover', { id, file: 'b.png' });
    expect((await w.view()).folders[0]?.cover).toBe('/thumbnail/b.f200.webp');
});

test("upstream's stored CSS urls read back as what they name", () => {
    expect(refOfCss('url("backgrounds/a%20b.png")')).toEqual({ file: 'a b.png', chat: false });
    expect(refOfCss("url('user/images/C/x%20y.png')")).toEqual({ file: 'user/images/C/x y.png', chat: true });
    expect(refOfCss(null)).toBeNull();
    expect(refOfCss('none')).toBeNull();
});

test("an LLM's reply picks the title it names, the longest when several fit", () => {
    const files = ['forest.png', 'forest at night.jpg', 'tavern.png'];
    expect(bestTitle(files, 'The scene moves to the Forest at night.')).toBe('forest at night.jpg');
    expect(bestTitle(files, 'tavern')).toBe('tavern.png');
    expect(bestTitle(files, 'a dark night')).toBe('forest at night.jpg');
    expect(bestTitle(files, 'space station')).toBeNull();
});

test("a chat change reads only the chat's view, never the backgrounds folder", async () => {
    const w = world([{ file: 'a.png' }]);
    const listed = { count: 0 };
    const area = backgroundsArea({
        files: {
            ...({} as Ports['files']),
            list: async () => {
                listed.count++;
                return [];
            },
            folders: async () => [],
        },
        chat: {
            read: async () => ({ list: [], locked: null }),
            write: async () => {},
            saveImage: async () => '',
            deleteImage: async () => {},
            images: async () => ({}),
        },
        options: { read: async () => ({}), write: async () => {} },
    });
    await area.views['backgrounds.chat']!({ user, session: 's', chat: { tree: '1' } });
    expect(listed.count).toBe(0);
    expect(area.followChat).toEqual(['backgrounds.chat']);
    void w;
});

test("an upload that isn't an image is refused", async () => {
    const w = world([{ file: 'a.png' }]);
    expect(
        await w.act(
            'backgrounds.upload',
            { chat: false },
            { path: '/tmp/x', name: 'x.html', type: 'text/html', size: 1 },
        ),
    ).toMatchObject({ refused: expect.any(String) });
});

test('with the chat locked, a background the model picks becomes the lock', async () => {
    const w = world(
        [{ file: 'forest.png' }, { file: 'tavern.png' }],
        { name: 'tavern.png' },
        { list: [], locked: 'url("backgrounds/tavern.png")' },
    );
    await w.act('backgrounds.pickByTitle', { reply: 'the forest' });
    expect(w.state.chat?.locked).toBe('url("backgrounds/forest.png")');
    expect(w.state.options.name).toBe('tavern.png');
});

test('a stored lock with a broken escape still reads', async () => {
    expect(refOfCss('url("backgrounds/100%.png")')).toEqual({ file: '100%.png', chat: false });
});
