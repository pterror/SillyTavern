import { createHash, randomUUID } from 'node:crypto';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';
import { NO_LOOK_STYLE } from '@st/protocol/looks';
import type { Looks, LookState, ResolvedLook } from '@st/protocol/looks';
import {
    APP_FONTS,
    MAX_USES,
    declarationsOfCss,
    isNoLook,
    isRefusal,
    resolveLevels,
    sanitizeDeclaration,
    storedLook,
} from './look.ts';
import type { FontsAllowed, Refusal, StoredLook } from './look.ts';
import { DRAWN_VIEW, LOOK_VIEW, SHARED_LOOKS_PER_READ, actions } from './protocol.ts';
import type { FontItem, Level, LookView, SharedLookItem, SharedLookRef, ThingKind, UsedLook } from './protocol.ts';

export type Who = { user: User; session: string };

// `world`: an entry's world, a world itself; null for what has none.
export type ThingRecord = { kind: ThingKind; world: string | null; look: unknown };

export type SharedRecord = SharedLookRef & { name: string; look: unknown };

export type Written = 'ok' | 'missing' | { refused: string };

export type Ports = {
    readThings(user: User, things: string[]): Promise<(ThingRecord | null)[]>;
    readTheme(user: User): Promise<unknown>;
    // Each id is looked for among `world`'s shared looks, when given, then the user's.
    readShared(user: User, world: string | null, ids: string[]): Promise<(SharedRecord | null)[]>;
    listShared(user: User, world: string | null): Promise<SharedLookItem[]>;
    worldFonts(user: User, world: string): Promise<{ id: string; name: string }[]>;
    // `edit` gets the level's look as stored when the write runs, in the level's own lane; an empty look clears it.
    editLook(who: Who, level: Level, edit: (current: unknown) => StoredLook | { refused: string }): Promise<Written>;
    makeShared(who: Who, ref: SharedLookRef, name: string): Promise<Written>;
    renameShared(who: Who, ref: SharedLookRef, name: string): Promise<Written>;
    deleteShared(who: Who, ref: SharedLookRef): Promise<Written>;
    moveShared(who: Who, ref: SharedLookRef, to: string | null): Promise<Written>;
    uploadFont(
        who: Who,
        world: string,
        file: Upload,
        name: string,
    ): Promise<{ id: string } | 'missing' | { refused: string }>;
};

const NOT_FOUND = 'That is gone.';
const NOT_AVAILABLE = "That shared look isn't one of this world's or yours.";
const NO_UPLOAD = 'Send the font with it.';

type Session = { open: string | null };

const styleId = (look: ResolvedLook): string =>
    createHash('sha256').update(JSON.stringify(look)).digest('hex').slice(0, 16);

const lookOf = (raw: unknown): StoredLook => storedLook(raw, 'any').look ?? {};

const appFonts = (): FontItem[] => Object.entries(APP_FONTS).map(([id, name]) => ({ id, name, uploaded: false }));

export function looksArea(ports: Ports) {
    const sessions = new Map<string, Session>();
    const drawnBy = new Map<string, Map<string, string[]>>();
    const sessionOf = (session: string): Session => {
        let found = sessions.get(session);
        if (!found) {
            found = { open: null };
            sessions.set(session, found);
        }
        return found;
    };
    const who = (context: ActionContext): Who => ({ user: context.user, session: context.session });

    async function resolve(user: User, things: string[]): Promise<Map<string, ResolvedLook>> {
        const unique = [...new Set(things)];
        const out = new Map<string, ResolvedLook>();
        if (unique.length === 0) return out;
        const records = new Map<string, ThingRecord | null>();
        (await ports.readThings(user, unique)).forEach((r, i) => records.set(unique[i] as string, r));
        const worlds = [
            ...new Set([...records.values()].flatMap((r) => (r && r.world !== null ? [r.world] : []))),
        ].filter((w) => !records.has(w));
        if (worlds.length > 0)
            (await ports.readThings(user, worlds)).forEach((r, i) => records.set(worlds[i] as string, r));
        const theme = lookOf(await ports.readTheme(user));
        const looks = new Map<string, StoredLook>();
        for (const [thing, r] of records) if (r) looks.set(thing, lookOf(r.look));
        const wanted = new Map<string | null, Set<string>>();
        let budget = SHARED_LOOKS_PER_READ;
        const want = (world: string | null, ids: string[] | undefined) => {
            for (const id of ids ?? []) {
                const set = wanted.get(world) ?? new Set<string>();
                if (set.has(id) || budget === 0) continue;
                budget--;
                set.add(id);
                wanted.set(world, set);
            }
        };
        for (const thing of unique) {
            const r = records.get(thing);
            if (!r) continue;
            if (r.world !== null && r.world !== thing) want(r.world, looks.get(r.world)?.uses);
            want(r.world, looks.get(thing)?.uses);
        }
        const shared = new Map<string, StoredLook>();
        const key = (world: string | null, id: string) => `${world ?? ''}/${id}`;
        for (const [world, ids] of wanted) {
            const list = [...ids];
            (await ports.readShared(user, world, list)).forEach((s, i) => {
                if (s) shared.set(key(world, list[i] as string), lookOf(s.look));
            });
        }
        const levelsOf = (world: string | null, look: StoredLook | undefined): StoredLook[] => [
            ...(look?.uses ?? []).flatMap((id) => {
                const found = shared.get(key(world, id));
                return found ? [found] : [];
            }),
            ...(look ? [look] : []),
        ];
        for (const thing of unique) {
            const r = records.get(thing);
            const own = levelsOf(r?.world ?? null, looks.get(thing));
            const world = r && r.world !== null && r.world !== thing ? levelsOf(r.world, looks.get(r.world)) : [];
            out.set(thing, resolveLevels([theme, ...world, ...own]));
        }
        return out;
    }

    async function looksFor(user: User, things: string[]): Promise<Looks> {
        const looks: Looks = { styles: {}, things: {} };
        for (const [thing, look] of await resolve(user, things)) {
            const id = isNoLook(look) ? NO_LOOK_STYLE : styleId(look);
            looks.styles[id] = look;
            looks.things[thing] = id;
        }
        return looks;
    }

    async function looksOf(
        context: ViewContext,
        view: string,
        things: string[],
        { adding = false }: { adding?: boolean } = {},
    ): Promise<Looks> {
        let views = drawnBy.get(context.session);
        if (!views) {
            views = new Map();
            drawnBy.set(context.session, views);
        }
        views.set(view, [...new Set([...(adding ? (views.get(view) ?? []) : []), ...things])]);
        return looksFor(context.user, things);
    }

    async function usedLooks(user: User, world: string | null, ids: string[]): Promise<UsedLook[]> {
        if (ids.length === 0) return [];
        const found = await ports.readShared(user, world, ids);
        return ids.map((id, i) => {
            const s = found[i];
            return s
                ? { id, world: s.world, name: s.name, look: lookOf(s.look) }
                : { id, world: null, name: null, look: null };
        });
    }

    async function readLookView(context: ViewContext): Promise<LookView> {
        const thing = sessionOf(context.session).open;
        if (thing === null) return { thing: null };
        const [record] = await ports.readThings(context.user, [thing]);
        if (!record) return { thing: null };
        const own = lookOf(record.look);
        const world = record.world;
        const [worldRecord] =
            world !== null && world !== thing ? await ports.readThings(context.user, [world]) : [null];
        const worldLook = worldRecord ? lookOf(worldRecord.look) : null;
        const uploaded = world !== null ? await ports.worldFonts(context.user, world) : [];
        const resolved = (await resolve(context.user, [thing])).get(thing) as ResolvedLook;
        return {
            thing,
            kind: record.kind,
            world,
            own,
            worldLook,
            worldUses: await usedLooks(context.user, world, worldLook?.uses ?? []),
            theme: lookOf(await ports.readTheme(context.user)),
            uses: await usedLooks(context.user, world, own.uses ?? []),
            available: await ports.listShared(context.user, world),
            fonts: [...appFonts(), ...uploaded.map((f) => ({ ...f, uploaded: true }))],
            resolved,
        };
    }

    async function fontsAt(user: User, at: Level): Promise<FontsAllowed | 'missing'> {
        let world: string | null = null;
        if ('thing' in at) {
            const [record] = await ports.readThings(user, [at.thing]);
            if (!record) return 'missing';
            world = record.world;
        } else if ('shared' in at) {
            world = at.shared.world;
        }
        if (world === null) return new Set();
        return new Set((await ports.worldFonts(user, world)).map((f) => f.id));
    }

    const answered = (written: Written, refused: Refusal[] = []): ActionResult => {
        if (written === 'missing') return { refused: NOT_FOUND, changed: [LOOK_VIEW] };
        if (typeof written === 'object') return { refused: written.refused, changed: [LOOK_VIEW] };
        return { changed: [LOOK_VIEW, DRAWN_VIEW], answer: { refused } };
    };

    async function editLayer(
        context: ActionContext,
        at: Level,
        state: LookState,
        change: (layer: Map<string, string>, fonts: FontsAllowed, refused: Refusal[]) => void,
    ): Promise<ActionResult> {
        const fonts = await fontsAt(context.user, at);
        if (fonts === 'missing') return answered('missing');
        const refused: Refusal[] = [];
        const written = await ports.editLook(who(context), at, (current) => {
            const look = lookOf(current);
            const layer = new Map((look[state] ?? []).map((d) => [d.property, d.value]));
            change(layer, fonts, refused);
            const next: StoredLook = { ...look };
            delete next[state];
            if (layer.size > 0) next[state] = [...layer].map(([property, value]) => ({ property, value }));
            return next;
        });
        return answered(written, refused);
    }

    const setChecked =
        (layer: Map<string, string>, fonts: FontsAllowed, refused: Refusal[]) => (property: string, value: string) => {
            const checked = sanitizeDeclaration(property, value, fonts);
            if (isRefusal(checked)) refused.push(checked);
            else {
                layer.delete(checked.property);
                layer.set(checked.property, checked.value);
            }
        };

    const editThingUses = (
        context: ActionContext,
        thing: string,
        change: (uses: string[]) => string[] | { refused: string },
    ) =>
        ports.editLook(who(context), { thing }, (current) => {
            const look = lookOf(current);
            const uses = change(look.uses ?? []);
            if (!Array.isArray(uses)) return uses;
            const next: StoredLook = { ...look };
            delete next.uses;
            if (uses.length > 0) next.uses = uses;
            return next;
        });

    const area = defineArea({
        schemas: actions,
        views: {
            [LOOK_VIEW]: readLookView,
            [DRAWN_VIEW]: async (context: ViewContext): Promise<{ looks: Looks }> => {
                const things = [...(drawnBy.get(context.session)?.values() ?? [])].flat();
                return { looks: await looksFor(context.user, things) };
            },
        },
        openFromStart: [DRAWN_VIEW],
        gone: (session) => {
            sessions.delete(session);
            drawnBy.delete(session);
        },
        actions: {
            'looks.open': async (context, { thing }) => {
                const [record] = await ports.readThings(context.user, [thing]);
                if (!record) return { refused: NOT_FOUND, changed: [] };
                sessionOf(context.session).open = thing;
                return { changed: [], opensViews: [LOOK_VIEW, DRAWN_VIEW], own: [LOOK_VIEW] };
            },
            'looks.close': async (context) => {
                sessionOf(context.session).open = null;
                return { changed: [LOOK_VIEW] };
            },
            'looks.setDeclarations': (context, { level, state, set, reset }) =>
                editLayer(context, level, state, (layer, fonts, refused) => {
                    for (const property of reset) layer.delete(property.trim().toLowerCase());
                    const put = setChecked(layer, fonts, refused);
                    for (const d of set) put(d.property, d.value);
                }),
            'looks.writeCss': async (context, { level, state, css }) => {
                const declarations = declarationsOfCss(css);
                if (!Array.isArray(declarations)) return { refused: declarations.refused, changed: [] };
                return editLayer(context, level, state, (layer, fonts, refused) => {
                    layer.clear();
                    const put = setChecked(layer, fonts, refused);
                    for (const d of declarations) put(d.property, d.value);
                });
            },
            'looks.setPicture': async (context, { level, before, after }) =>
                answered(
                    await ports.editLook(who(context), level, (current) => {
                        const look = lookOf(current);
                        const picture = { ...look.picture };
                        if (before === null) delete picture.before;
                        else picture.before = before;
                        if (after === null) delete picture.after;
                        else picture.after = after;
                        const next: StoredLook = { ...look };
                        delete next.picture;
                        if (Object.keys(picture).length > 0) next.picture = picture;
                        return next;
                    }),
                ),
            'looks.setNote': async (context, { level, note }) =>
                answered(
                    await ports.editLook(who(context), level, (current) => {
                        const next: StoredLook = { ...lookOf(current) };
                        delete next.note;
                        if (note !== null) next.note = note;
                        return next;
                    }),
                ),
            'looks.makeShared': async (context, { name, world, usedBy }) => {
                if (usedBy !== null && world !== null) {
                    const [record] = await ports.readThings(context.user, [usedBy]);
                    if (!record) return answered('missing');
                    if (record.world !== world) return { refused: NOT_AVAILABLE, changed: [] };
                }
                const id = randomUUID();
                const made = await ports.makeShared(who(context), { id, world }, name);
                if (made !== 'ok' || usedBy === null) return { ...answered(made), answer: { id, refused: [] } };
                const used = await editThingUses(context, usedBy, (uses) =>
                    uses.length >= MAX_USES
                        ? { refused: `A thing uses at most ${MAX_USES} shared looks.` }
                        : [...uses, id],
                );
                return { ...answered(used), answer: { id, refused: [] } };
            },
            'looks.renameShared': async (context, { shared, name }) =>
                answered(await ports.renameShared(who(context), shared, name)),
            'looks.deleteShared': async (context, { shared }) =>
                answered(await ports.deleteShared(who(context), shared)),
            'looks.moveShared': async (context, { shared, to }) =>
                shared.world === to ? answered('ok') : answered(await ports.moveShared(who(context), shared, to)),
            'looks.use': async (context, { thing, shared, before }) => {
                const [record] = await ports.readThings(context.user, [thing]);
                if (!record) return answered('missing');
                const [found] = await ports.readShared(context.user, record.world, [shared]);
                if (!found) return { refused: NOT_AVAILABLE, changed: [LOOK_VIEW] };
                return answered(
                    await editThingUses(context, thing, (uses) => {
                        const rest = uses.filter((id) => id !== shared);
                        if (rest.length >= MAX_USES)
                            return { refused: `A thing uses at most ${MAX_USES} shared looks.` };
                        const at = before === null ? -1 : rest.indexOf(before);
                        return at === -1 ? [...rest, shared] : [...rest.slice(0, at), shared, ...rest.slice(at)];
                    }),
                );
            },
            'looks.stopUsing': async (context, { thing, shared }) =>
                answered(await editThingUses(context, thing, (uses) => uses.filter((id) => id !== shared))),
            'looks.uploadFont': async (context, { world, name }) => {
                if (!context.upload) return { refused: NO_UPLOAD, changed: [] };
                const made = await ports.uploadFont(who(context), world, context.upload, name);
                if (made === 'missing' || 'refused' in made) return answered(made);
                return { changed: [LOOK_VIEW], answer: { id: made.id } };
            },
        },
    });
    return { area, looksOf, looksFor };
}
