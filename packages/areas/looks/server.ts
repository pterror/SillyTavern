import { createHash, randomUUID } from 'node:crypto';
import type * as v from 'valibot';
import { defineArea } from '@st/server-ui';
import type { ActionContext, ActionResult, Upload, User, ViewContext } from '@st/server-ui';
import { LOOK_STATES, MARK_STATES, NO_LOOK_STYLE } from '@st/protocol/looks';
import type { Looks, LookState, MarkLayer, MarkState, Named, ResolvedLook } from '@st/protocol/looks';
import {
    APP_FONTS,
    FONT_FORMATS,
    MAX_USES,
    declarationsOfCss,
    fontFamily,
    fontUrl,
    isNoLook,
    isRefusal,
    lookImageUrl,
    markColor,
    pictureCrop,
    resolveLevels,
    resolveMark,
    sanitizeDeclaration,
    storedLook,
    storedMark,
} from './look.ts';
import type { FontsAllowed, Picture, Refusal, StoredLook, StoredMark } from './look.ts';
import { DRAWN_VIEW, LOOK_VIEW, SHARED_LOOKS_PER_READ, THEME_VIEW, actions } from './protocol.ts';
import type {
    FontItem,
    Level,
    LevelItem,
    LookView,
    MarkView,
    Placed,
    Placement,
    SharedLookItem,
    SharedLookRef,
    Shown,
    ThingKind,
    ThemeView,
    UsedLook,
} from './protocol.ts';

export type Who = { user: User; session: string };

// `world`: an entry's world, a world itself; null for what has none.
export type ThingRecord = { kind: ThingKind; world: string | null; look: unknown };

export type SharedRecord = SharedLookRef & { name: string; look: unknown };

export type Written = 'ok' | 'missing' | { refused: string };

export type Described = { named: Named; picture: string | null };

export type Ports = {
    readThings(user: User, things: string[]): Promise<(ThingRecord | null)[]>;
    // The thing's name as it is drawn, and the URL of its own picture when it has one.
    describe(user: User, thing: string, kind: ThingKind): Promise<Described | null>;
    // Stores an image by its bytes, answering its id.
    storeImage(who: Who, file: Upload): Promise<{ id: string } | { refused: string }>;
    // The theme's look and the trigger mark's, as stored, in one read.
    readTheme(user: User): Promise<{ look: unknown; mark: unknown }>;
    // Each id is looked for among `world`'s shared looks, when given, then the user's.
    readShared(user: User, world: string | null, ids: string[]): Promise<(SharedRecord | null)[]>;
    listShared(user: User, world: string | null): Promise<SharedLookItem[]>;
    worldFonts(user: User, world: string): Promise<{ id: string; name: string }[]>;
    // `edit` gets the level's look as stored when the write runs, in the level's own lane; an empty look clears it.
    editLook(who: Who, level: Level, edit: (current: unknown) => StoredLook | { refused: string }): Promise<Written>;
    // As editLook, for the trigger mark; an empty mark clears it.
    editMark(who: Who, edit: (current: unknown) => StoredMark | { refused: string }): Promise<Written>;
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

const NOT_FOUND = 'Not found.';
const NOT_AVAILABLE = 'That shared look isn’t available here.';
const NO_UPLOAD = 'Choose a font file.';
const NO_PICTURE = 'Choose an image.';
const NOT_IN_CHAIN = 'That look isn’t applied to this name.';
const TOO_MANY_USES = `Up to ${MAX_USES} shared looks.`;
const BAD_CROP = 'The crop must cover at least 5% of each side.';

// A layer of a look, changed as a map from property to value, in the order they were last set.
function withLayer(look: StoredLook, state: LookState, change: (layer: Map<string, string>) => void): StoredLook {
    const layer = new Map((look[state] ?? []).map((d) => [d.property, d.value]));
    change(layer);
    const next: StoredLook = { ...look };
    delete next[state];
    if (layer.size > 0) next[state] = [...layer].map(([property, value]) => ({ property, value }));
    return next;
}

type Session = { open: string | null };

type Leveled = { item: LevelItem; look: StoredLook };

const styleId = (look: ResolvedLook): string =>
    createHash('sha256').update(JSON.stringify(look)).digest('hex').slice(0, 16);

const lookOf = (raw: unknown): StoredLook => storedLook(raw, 'any').look ?? {};

type Theme = { look: unknown; mark: unknown };

const markViewOf = (theme: Theme): MarkView => {
    const stored = storedMark(theme.mark);
    return { stored, shown: resolveMark(stored) };
};

const appFonts = (): FontItem[] =>
    Object.entries(APP_FONTS).map(([id, name]) => ({ id, name, uploaded: false, family: name, face: null }));

const uploadedFont = ({ id, name }: { id: string; name: string }): FontItem => ({
    id,
    name,
    uploaded: true,
    family: fontFamily(id),
    face: {
        family: fontFamily(id),
        url: fontUrl(id),
        format: FONT_FORMATS[id.slice(id.lastIndexOf('.') + 1)] ?? 'woff2',
    },
});

const levelKey = (level: Level): string =>
    'theme' in level ? 'theme' : 'thing' in level ? `thing:${level.thing}` : `shared:${level.shared.id}`;

// Each state is its layer over the ones below it; in a layer the most specific level wins.
export function shownOf(looks: StoredLook[]): Record<LookState, Shown[]> {
    const out = {} as Record<LookState, Shown[]>;
    LOOK_STATES.forEach((state, at) => {
        const merged = new Map<string, Shown>();
        for (const layer of LOOK_STATES.slice(0, at + 1)) {
            looks.forEach((look, level) => {
                for (const d of look[layer] ?? []) {
                    merged.delete(d.property);
                    merged.set(d.property, { ...d, state: layer, level });
                }
            });
        }
        out[state] = [...merged.values()];
    });
    return out;
}

export function placementOf(looks: StoredLook[]): Placement {
    let before: Placed<boolean> | null = null;
    let after: Placed<boolean> | null = null;
    let note: Placed<string> | null = null;
    looks.forEach((look, level) => {
        if (look.picture?.before !== undefined) before = { value: look.picture.before, level };
        if (look.picture?.after !== undefined) after = { value: look.picture.after, level };
        if (look.note !== undefined) note = { value: look.note, level };
    });
    return { before, after, note };
}

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

    async function resolve(user: User, things: string[], read?: Theme): Promise<Map<string, ResolvedLook>> {
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
        const theme = lookOf((read ?? (await ports.readTheme(user))).look);
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

    async function looksFor(user: User, things: string[], theme?: Theme): Promise<Looks> {
        const looks: Looks = { styles: {}, things: {} };
        for (const [thing, look] of await resolve(user, things, theme)) {
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

    // The levels a thing's look resolves through, each with its look as stored.
    async function chainOf(user: User, thing: string) {
        const [record] = await ports.readThings(user, [thing]);
        if (!record) return null;
        const own = lookOf(record.look);
        const world = record.world !== null && record.world !== thing ? record.world : null;
        const [worldRecord] = world !== null ? await ports.readThings(user, [world]) : [null];
        const worldLook = worldRecord ? lookOf(worldRecord.look) : null;
        const worldName = world !== null ? ((await ports.describe(user, world, 'world'))?.named.text ?? '') : '';
        const worldUses = await usedLooks(user, record.world, worldLook?.uses ?? []);
        const uses = await usedLooks(user, record.world, own.uses ?? []);
        const shared = (used: UsedLook, by: 'world' | 'thing'): Leveled => ({
            item: { kind: 'shared', level: { shared: { id: used.id, world: used.world } }, name: used.name, by },
            look: used.look ?? {},
        });
        const read = await ports.readTheme(user);
        const theme: Leveled = { item: { kind: 'theme', level: { theme: true } }, look: lookOf(read.look) };
        const ofWorld: Leveled[] =
            world !== null && worldLook !== null
                ? [
                      ...worldUses.map((u) => shared(u, 'world')),
                      { item: { kind: 'world', level: { thing: world }, name: worldName }, look: worldLook },
                  ]
                : [];
        const levels: Leveled[] = [
            theme,
            ...ofWorld,
            ...uses.map((u) => shared(u, 'thing')),
            { item: { kind: 'thing', level: { thing } }, look: own },
        ];
        return { record, own, uses, levels, theme: read };
    }

    async function readLookView(context: ViewContext): Promise<LookView> {
        const thing = sessionOf(context.session).open;
        if (thing === null) return { thing: null };
        const chain = await chainOf(context.user, thing);
        if (!chain) return { thing: null };
        const { record, own, uses, levels, theme } = chain;
        const described = await ports.describe(context.user, thing, record.kind);
        const uploaded = record.world !== null ? await ports.worldFonts(context.user, record.world) : [];
        const looks = levels.map((l) => l.look);
        return {
            thing,
            kind: record.kind,
            world: record.world,
            named: described?.named ?? { thing, text: '', shownAs: 'name' },
            picture: {
                own: described?.picture ?? null,
                image: own.picture?.image === undefined ? null : lookImageUrl(own.picture.image),
                crop: own.picture?.crop ?? null,
            },
            levels: levels.map((l) => l.item),
            shown: shownOf(looks),
            placement: placementOf(looks),
            own,
            uses,
            available: await ports.listShared(context.user, record.world),
            fonts: [...appFonts(), ...uploaded.map(uploadedFont)],
            mark: markViewOf(theme),
            looks: await looksOf(context, LOOK_VIEW, [thing]),
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

    // `theme`: the edit changes what the theme settings show.
    const answered = (written: Written, refused: Refusal[] = [], theme = false): ActionResult => {
        if (written === 'missing') return { refused: NOT_FOUND, changed: [LOOK_VIEW] };
        if (typeof written === 'object') return { refused: written.refused, changed: [LOOK_VIEW] };
        return { changed: [LOOK_VIEW, DRAWN_VIEW, ...(theme ? [THEME_VIEW] : [])], answer: { refused } };
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
        const written = await ports.editLook(who(context), at, (current) =>
            withLayer(lookOf(current), state, (layer) => change(layer, fonts, refused)),
        );
        return answered(written, refused);
    }

    // The small picture's own parts: what it shows, on the thing's own look.
    const editPicture = (
        context: ActionContext,
        thing: string,
        change: (picture: Picture) => { [K in keyof Picture]?: Picture[K] | null },
    ) =>
        ports.editLook(who(context), { thing }, (current) => {
            const look = lookOf(current);
            const changed = change({ ...look.picture });
            const picture: Picture = {};
            for (const [key, value] of Object.entries(changed) as [keyof Picture, unknown][])
                if (value !== null && value !== undefined) Object.assign(picture, { [key]: value });
            const next: StoredLook = { ...look };
            delete next.picture;
            if (Object.keys(picture).length > 0) next.picture = picture;
            return next;
        });

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

    async function applyTo(
        context: ActionContext,
        { thing, what, from, to }: v.InferOutput<(typeof actions)['looks.applyTo']>,
    ): Promise<ActionResult> {
        const chain = await chainOf(context.user, thing);
        if (!chain) return answered('missing');
        const keys = chain.levels.map((l) => levelKey(l.item.level));
        const fromAt = keys.indexOf(levelKey(from));
        if (fromAt === -1) return { refused: NOT_IN_CHAIN, changed: [LOOK_VIEW] };
        let target: Level;
        let targetAt: number;
        if ('newShared' in to) {
            const { name, world } = to.newShared;
            if (world !== null && world !== chain.record.world) return { refused: NOT_AVAILABLE, changed: [] };
            if ((chain.own.uses ?? []).length >= MAX_USES) return { refused: TOO_MANY_USES, changed: [] };
            const id = randomUUID();
            const made = await ports.makeShared(who(context), { id, world }, name);
            if (made !== 'ok') return answered(made);
            const used = await editThingUses(context, thing, (uses) =>
                uses.length >= MAX_USES ? { refused: TOO_MANY_USES } : [...uses, id],
            );
            if (used !== 'ok') return answered(used);
            target = { shared: { id, world } };
            targetAt = keys.length - 1;
        } else {
            target = to;
            targetAt = keys.indexOf(levelKey(to));
            if (targetAt === -1) return { refused: NOT_IN_CHAIN, changed: [LOOK_VIEW] };
            if (targetAt === fromAt) return answered('ok');
        }
        const fromLook = chain.levels[fromAt]?.look ?? {};
        const looks = chain.levels.map((l) => l.look);
        const takeOff = targetAt < fromAt || 'newShared' in to;
        if ('state' in what) {
            const shown = new Map(shownOf(looks)[what.state].map((d) => [d.property, d.value]));
            const own = new Map((fromLook[what.state] ?? []).map((d) => [d.property, d.value]));
            const fonts = await fontsAt(context.user, target);
            if (fonts === 'missing') return answered('missing');
            const refused: Refusal[] = [];
            const written: string[] = [];
            const put = await ports.editLook(who(context), target, (current) =>
                withLayer(lookOf(current), what.state, (layer) => {
                    for (const property of what.properties) {
                        const value = own.get(property) ?? shown.get(property);
                        if (value === undefined) continue;
                        const checked = sanitizeDeclaration(property, value, fonts);
                        if (isRefusal(checked)) refused.push(checked);
                        else {
                            layer.delete(checked.property);
                            layer.set(checked.property, checked.value);
                            written.push(checked.property);
                        }
                    }
                }),
            );
            if (put !== 'ok' || !takeOff || written.length === 0) return answered(put, refused);
            const taken = await ports.editLook(who(context), from, (current) =>
                withLayer(lookOf(current), what.state, (layer) => {
                    for (const property of written) layer.delete(property);
                }),
            );
            return answered(taken, refused);
        }
        const placement = placementOf(looks);
        const put = await ports.editLook(who(context), target, (current) => {
            const next: StoredLook = { ...lookOf(current) };
            if ('note' in what) {
                const note = fromLook.note ?? placement.note?.value;
                if (note !== undefined) next.note = note;
            } else {
                const before = fromLook.picture?.before ?? placement.before?.value;
                const after = fromLook.picture?.after ?? placement.after?.value;
                next.picture = {
                    ...next.picture,
                    ...(before === undefined ? {} : { before }),
                    ...(after === undefined ? {} : { after }),
                };
            }
            return next;
        });
        if (put !== 'ok' || !takeOff) return answered(put);
        return answered(
            await ports.editLook(who(context), from, (current) => {
                const next: StoredLook = { ...lookOf(current) };
                if ('note' in what) delete next.note;
                else if (next.picture) {
                    const rest = { ...next.picture };
                    delete rest.before;
                    delete rest.after;
                    delete next.picture;
                    if (Object.keys(rest).length > 0) next.picture = rest;
                }
                return next;
            }),
        );
    }

    const area = defineArea({
        schemas: actions,
        views: {
            [LOOK_VIEW]: readLookView,
            [DRAWN_VIEW]: async (context: ViewContext): Promise<{ looks: Looks }> => {
                const things = [...(drawnBy.get(context.session)?.values() ?? [])].flat();
                const theme = await ports.readTheme(context.user);
                return { looks: { ...(await looksFor(context.user, things, theme)), mark: markViewOf(theme).shown } };
            },
            [THEME_VIEW]: async (context: ViewContext): Promise<ThemeView> => ({
                mark: markViewOf(await ports.readTheme(context.user)),
                shared: await ports.listShared(context.user, null),
            }),
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
            'looks.writeCss': async (context, { thing, state, css, replaces, newAt }) => {
                const declarations = declarationsOfCss(css);
                if (!Array.isArray(declarations)) return { refused: declarations.refused, changed: [] };
                const chain = await chainOf(context.user, thing);
                if (!chain) return answered('missing');
                const keys = chain.levels.map((l) => levelKey(l.item.level));
                const newAtIndex = keys.indexOf(levelKey(newAt));
                if (newAtIndex === -1) return { refused: NOT_IN_CHAIN, changed: [LOOK_VIEW] };
                const supplier = new Map<string, { at: number; value: string }>();
                chain.levels.forEach((l, at) => {
                    for (const d of l.look[state] ?? []) supplier.set(d.property, { at, value: d.value });
                });
                const edits = new Map<number, { set: Map<string, string>; reset: Set<string> }>();
                const editAt = (at: number) => {
                    let found = edits.get(at);
                    if (!found) {
                        found = { set: new Map(), reset: new Set() };
                        edits.set(at, found);
                    }
                    return found;
                };
                const typed = new Set<string>();
                for (const d of declarations) {
                    const property = d.property.trim().toLowerCase();
                    typed.add(property);
                    const from = supplier.get(property);
                    if (from && from.value === d.value.trim().replace(/\s+/g, ' ')) continue;
                    editAt(from?.at ?? newAtIndex).set.set(property, d.value);
                }
                for (const raw of replaces) {
                    const property = raw.trim().toLowerCase();
                    const from = supplier.get(property);
                    if (!typed.has(property) && from) editAt(from.at).reset.add(property);
                }
                const refused: Refusal[] = [];
                let written: Written = 'ok';
                for (const [at, edit] of [...edits].sort(([a], [b]) => b - a)) {
                    const level = chain.levels[at]?.item.level;
                    if (!level) continue;
                    const fonts = await fontsAt(context.user, level);
                    if (fonts === 'missing') return answered('missing', refused);
                    written = await ports.editLook(who(context), level, (current) =>
                        withLayer(lookOf(current), state, (layer) => {
                            for (const property of edit.reset) layer.delete(property);
                            const put = setChecked(layer, fonts, refused);
                            for (const [property, value] of edit.set) put(property, value);
                        }),
                    );
                    if (written !== 'ok') break;
                }
                return answered(written, refused);
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
                if (made !== 'ok' || usedBy === null)
                    return { ...answered(made, [], world === null), answer: { id, refused: [] } };
                const used = await editThingUses(context, usedBy, (uses) =>
                    uses.length >= MAX_USES ? { refused: TOO_MANY_USES } : [...uses, id],
                );
                return { ...answered(used, [], world === null), answer: { id, refused: [] } };
            },
            'looks.setMark': async (context, { change }) => {
                const colors = new Map<MarkState, string>();
                for (const state of MARK_STATES) {
                    const color = change[state]?.color;
                    if (typeof color !== 'string') continue;
                    const checked = markColor(color);
                    if ('refused' in checked) return { refused: `Highlight color: ${checked.refused}`, changed: [] };
                    colors.set(state, checked.color);
                }
                const written = await ports.editMark(who(context), (current) => {
                    const mark = storedMark(current);
                    for (const state of MARK_STATES) {
                        const layer = change[state];
                        if (!layer) continue;
                        const next: Partial<MarkLayer> = { ...mark[state] };
                        if (layer.style === null) delete next.style;
                        else if (layer.style !== undefined) next.style = layer.style;
                        if (layer.color === null) delete next.color;
                        else if (layer.color !== undefined) next.color = colors.get(state) ?? layer.color;
                        if (layer.opacity === null) delete next.opacity;
                        else if (layer.opacity !== undefined) next.opacity = layer.opacity;
                        delete mark[state];
                        if (Object.keys(next).length > 0) mark[state] = next;
                    }
                    return mark;
                });
                return answered(written, [], true);
            },
            'looks.resetMark': async (context) => answered(await ports.editMark(who(context), () => ({})), [], true),
            'looks.renameShared': async (context, { shared, name }) =>
                answered(await ports.renameShared(who(context), shared, name), [], shared.world === null),
            'looks.deleteShared': async (context, { shared }) =>
                answered(await ports.deleteShared(who(context), shared), [], shared.world === null),
            'looks.moveShared': async (context, { shared, to }) =>
                shared.world === to
                    ? answered('ok')
                    : answered(await ports.moveShared(who(context), shared, to), [], true),
            'looks.use': async (context, { thing, shared, before }) => {
                const [record] = await ports.readThings(context.user, [thing]);
                if (!record) return answered('missing');
                const [found] = await ports.readShared(context.user, record.world, [shared]);
                if (!found) return { refused: NOT_AVAILABLE, changed: [LOOK_VIEW] };
                return answered(
                    await editThingUses(context, thing, (uses) => {
                        const rest = uses.filter((id) => id !== shared);
                        if (rest.length >= MAX_USES) return { refused: TOO_MANY_USES };
                        const at = before === null ? -1 : rest.indexOf(before);
                        return at === -1 ? [...rest, shared] : [...rest.slice(0, at), shared, ...rest.slice(at)];
                    }),
                );
            },
            'looks.stopUsing': async (context, { thing, shared }) =>
                answered(await editThingUses(context, thing, (uses) => uses.filter((id) => id !== shared))),
            'looks.applyTo': async (context, payload) => {
                const result = await applyTo(context, payload);
                const made = 'newShared' in payload.to && payload.to.newShared.world === null;
                return made && !('refused' in result)
                    ? { ...result, changed: [...result.changed, THEME_VIEW] }
                    : result;
            },
            'looks.cropPicture': async (context, { thing, crop }) => {
                const kept = crop === null ? null : pictureCrop(crop);
                if (crop !== null && kept === null) return { refused: BAD_CROP, changed: [] };
                return answered(await editPicture(context, thing, (picture) => ({ ...picture, crop: kept })));
            },
            'looks.useOwnPicture': async (context, { thing }) =>
                answered(await editPicture(context, thing, (picture) => ({ ...picture, crop: null, image: null }))),
            'looks.uploadPicture': async (context, { thing }) => {
                if (!context.upload) return { refused: NO_PICTURE, changed: [] };
                const [record] = await ports.readThings(context.user, [thing]);
                if (!record) return answered('missing');
                const stored = await ports.storeImage(who(context), context.upload);
                if ('refused' in stored) return { refused: stored.refused, changed: [] };
                return answered(
                    await editPicture(context, thing, (picture) => ({ ...picture, crop: null, image: stored.id })),
                );
            },
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
