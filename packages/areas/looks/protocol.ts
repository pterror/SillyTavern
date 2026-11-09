import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';
import { LOOK_STATES } from '@st/protocol/looks';
import type { ResolvedLook } from '@st/protocol/looks';
import {
    CSS_LENGTH_AT_MOST,
    DECLARATIONS_PER_LAYER_AT_MOST,
    NOTE_LENGTH_AT_MOST,
    SHARED_LOOK_ID,
    SHARED_LOOK_NAME_AT_MOST,
} from './look.ts';
import type { Refusal, StoredLook } from './look.ts';

export type { Refusal, StoredLook };

export const LOOK_VIEW = 'looks.look';
export const DRAWN_VIEW = 'looks.drawn';

// Distinct shared looks one resolution reads, at two reads each; past them a name is drawn without the rest.
export const SHARED_LOOKS_PER_READ = 64;
// One resolution's reads besides one per thing drawn: the theme (the user's looks and its field), the world's look, and
// the shared looks.
export const READS_OF_LOOKS_BESIDES_THINGS = 3 + 2 * SHARED_LOOKS_PER_READ;
export const FONT_BYTES_AT_MOST = 4 * 1024 * 1024;

export type ThingKind = 'entry' | 'world' | 'character' | 'persona' | 'bookmark';

// `world` null: the user's, available in every world.
export type SharedLookRef = { id: string; world: string | null };

export type SharedLookItem = SharedLookRef & { name: string };

// `name` null: the thing names a shared look that is gone or isn't available to it.
export type UsedLook = SharedLookRef & { name: string | null; look: StoredLook | null };

export type FontItem = { id: string; name: string; uploaded: boolean };

export type Level = { theme: true } | { thing: string } | { shared: SharedLookRef };

export type LookView =
    | {
          thing: string;
          kind: ThingKind;
          world: string | null;
          own: StoredLook;
          worldLook: StoredLook | null;
          worldUses: UsedLook[];
          theme: StoredLook;
          uses: UsedLook[];
          available: SharedLookItem[];
          fonts: FontItem[];
          resolved: ResolvedLook;
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
const sharedName = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, 'A shared look needs a name.'),
    v.maxLength(SHARED_LOOK_NAME_AT_MOST),
);

export const actions = {
    'looks.open': v.object({ thing: thingId }),
    'looks.close': v.object({}),
    'looks.setDeclarations': v.object({
        level,
        state,
        set: v.pipe(v.array(declaration), v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST)),
        reset: v.pipe(v.array(v.pipe(v.string(), v.maxLength(64))), v.maxLength(DECLARATIONS_PER_LAYER_AT_MOST)),
    }),
    'looks.writeCss': v.object({ level, state, css: v.pipe(v.string(), v.maxLength(CSS_LENGTH_AT_MOST)) }),
    'looks.setPicture': v.object({ level, before: v.nullable(v.boolean()), after: v.nullable(v.boolean()) }),
    'looks.setNote': v.object({ level, note: v.nullable(v.pipe(v.string(), v.maxLength(NOTE_LENGTH_AT_MOST))) }),
    'looks.makeShared': v.object({ name: sharedName, world: v.nullable(entityId), usedBy: v.nullable(thingId) }),
    'looks.renameShared': v.object({ shared: sharedRef, name: sharedName }),
    'looks.deleteShared': v.object({ shared: sharedRef }),
    'looks.moveShared': v.object({ shared: sharedRef, to: v.nullable(entityId) }),
    'looks.use': v.object({ thing: thingId, shared: sharedId, before: v.nullable(sharedId) }),
    'looks.stopUsing': v.object({ thing: thingId, shared: sharedId }),
    'looks.uploadFont': v.object({
        world: entityId,
        name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
    }),
} satisfies ActionSchemas;
