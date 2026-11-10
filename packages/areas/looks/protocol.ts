import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';
import { DRAWN_VIEW, LOOK_STATES, MARK_STYLES } from '@st/protocol/looks';
import type {
    Declaration,
    FontFace,
    Looks,
    LookState,
    MarkState,
    Named,
    PictureCrop,
    ResolvedMark,
} from '@st/protocol/looks';
import {
    CSS_LENGTH_AT_MOST,
    DECLARATIONS_PER_LAYER_AT_MOST,
    NOTE_LENGTH_AT_MOST,
    SHARED_LOOK_ID,
    SHARED_LOOK_NAME_AT_MOST,
} from './look.ts';
import type { Refusal, StoredLook, StoredMark } from './look.ts';

export type { Refusal, StoredLook, StoredMark };

export const LOOK_VIEW = 'looks.look';
// The theme settings' part: the trigger mark and the user's own shared looks.
export const THEME_VIEW = 'looks.theme';
export { DRAWN_VIEW };

// Distinct shared looks one resolution reads, at two reads each; past them a name is drawn without the rest.
export const SHARED_LOOKS_PER_READ = 64;
// One resolution's reads besides one per thing drawn: the theme (the user's looks and its field), the world's look, and
// the shared looks.
export const READS_OF_LOOKS_BESIDES_THINGS = 3 + 2 * SHARED_LOOKS_PER_READ;
export const FONT_BYTES_AT_MOST = 4 * 1024 * 1024;
export { IMAGE_BYTES_AT_MOST } from './look.ts';

export type ThingKind = 'entry' | 'world' | 'character' | 'persona' | 'bookmark';

// `world` null: the user's, available in every world.
export type SharedLookRef = { id: string; world: string | null };

export type SharedLookItem = SharedLookRef & { name: string };

// `name` null: the thing names a shared look that is gone or isn't available to it.
export type UsedLook = SharedLookRef & { name: string | null; look: StoredLook | null };

// `family`: what a look's font-family draws it as; `face`: its @font-face, for an uploaded font.
export type FontItem = { id: string; name: string; uploaded: boolean; family: string; face: FontFace | null };

export type Level = { theme: true } | { thing: string } | { shared: SharedLookRef };

// The levels a thing's look resolves through, least specific first: the theme, its world's shared looks and its world
// (when it has one and isn't it), the shared looks it uses, the thing. `by` says whose a shared look's use is.
export type LevelItem =
    | { kind: 'theme'; level: { theme: true } }
    | { kind: 'world'; level: { thing: string }; name: string }
    | { kind: 'shared'; level: { shared: SharedLookRef }; name: string | null; by: 'world' | 'thing' }
    | { kind: 'thing'; level: { thing: string } };

// A declaration as a state shows it (that state's layer over the ones below it): the layer it comes from and the level
// that sets it, an index into `levels`.
export type Shown = Declaration & { state: LookState; level: number };

export type Placed<T> = { value: T; level: number };

// `own`: the URL of the thing's own picture (none for what has no picture); `image` and `crop`: what its small picture
// shows instead, from its own look.
export type Placement = {
    before: Placed<boolean> | null;
    after: Placed<boolean> | null;
    note: Placed<string> | null;
};

export type SmallPicture = { own: string | null; image: string | null; crop: PictureCrop | null };

// The trigger mark as the theme stores it and as each state draws it.
export type MarkView = { stored: StoredMark; shown: ResolvedMark };

export type ThemeView = { mark: MarkView; shared: SharedLookItem[] };

export type LookView =
    | {
          thing: string;
          kind: ThingKind;
          world: string | null;
          named: Named;
          picture: SmallPicture;
          levels: LevelItem[];
          shown: Record<LookState, Shown[]>;
          placement: Placement;
          own: StoredLook;
          uses: UsedLook[];
          available: SharedLookItem[];
          fonts: FontItem[];
          mark: MarkView;
          looks: Looks;
      }
    | { thing: null };

export const thingId = v.pipe(v.string(), v.regex(/^(\d+|bookmark-\d+)$/));
const entityId = v.pipe(v.string(), v.regex(/^\d+$/));
const sharedId = v.pipe(v.string(), v.regex(SHARED_LOOK_ID));
const sharedRef = v.object({ id: sharedId, world: v.nullable(entityId) });
const level = v.union([
    v.strictObject({ theme: v.literal(true) }),
    v.strictObject({ thing: thingId }),
    v.strictObject({ shared: sharedRef }),
]);
const state = v.picklist(LOOK_STATES);
const declaration = v.object({ property: v.pipe(v.string(), v.maxLength(64)), value: v.string() });
const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const crop = v.object({ x: unit, y: unit, width: unit, height: unit });
const sharedName = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'A shared look needs a name.'),
    v.maxLength(SHARED_LOOK_NAME_AT_MOST),
);

const markLayerChange = v.partial(
    v.object({
        style: v.nullable(v.picklist(MARK_STYLES)),
        color: v.nullable(v.pipe(v.string(), v.maxLength(200))),
        opacity: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
    }),
);
const markChange = {
    rest: markLayerChange,
    messagePointed: markLayerChange,
    wordPointed: markLayerChange,
} satisfies Record<MarkState, unknown>;

export const actions = {
    'looks.open': v.object({ thing: thingId }),
    'looks.close': v.object({}),
    'looks.setDeclarations': v.object({
        level,
        state,
        set: v.pipe(v.array(declaration), v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST)),
        reset: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST)),
    }),
    // The state's layer as the thing shows it: a declaration typed goes to the level that sets it, a new one to `newAt`;
    // each of `replaces` the text leaves out is taken off the level that sets it.
    'looks.writeCss': v.object({
        thing: thingId,
        state,
        css: v.pipe(v.string(), v.maxLength(CSS_LENGTH_AT_MOST)),
        replaces: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST)),
        newAt: level,
    }),
    // Each state's settings: a value sets it, null leaves it to the state below.
    'looks.setMark': v.object({ change: v.partial(v.object(markChange)) }),
    'looks.resetMark': v.object({}),
    'looks.setPicture': v.object({ level, before: v.nullable(v.boolean()), after: v.nullable(v.boolean()) }),
    'looks.setNote': v.object({ level, note: v.nullable(v.pipe(v.string(), v.maxLength(NOTE_LENGTH_AT_MOST))) }),
    'looks.makeShared': v.object({ name: sharedName, world: v.nullable(entityId), usedBy: v.nullable(thingId) }),
    'looks.renameShared': v.object({ shared: sharedRef, name: sharedName }),
    'looks.deleteShared': v.object({ shared: sharedRef }),
    'looks.moveShared': v.object({ shared: sharedRef, to: v.nullable(entityId) }),
    'looks.use': v.object({ thing: thingId, shared: sharedId, before: v.nullable(sharedId) }),
    'looks.stopUsing': v.object({ thing: thingId, shared: sharedId }),
    // Moves what `what` names from the level that shows it to another (a new shared look, made in the same request);
    // moving it to a less specific level takes it off the one it was on.
    'looks.applyTo': v.object({
        thing: thingId,
        what: v.union([
            v.strictObject({
                state,
                properties: v.pipe(
                    v.array(v.pipe(v.string(), v.maxLength(64))),
                    v.minLength(1),
                    v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST),
                ),
            }),
            v.strictObject({ picture: v.literal(true) }),
            v.strictObject({ note: v.literal(true) }),
        ]),
        from: level,
        to: v.union([
            level,
            v.strictObject({ newShared: v.object({ name: sharedName, world: v.nullable(entityId) }) }),
        ]),
    }),
    'looks.cropPicture': v.object({ thing: thingId, crop: v.nullable(crop) }),
    'looks.useOwnPicture': v.object({ thing: thingId }),
    'looks.uploadPicture': v.object({ thing: thingId }),
    'looks.uploadFont': v.object({
        world: entityId,
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    }),
} satisfies ActionSchemas;
