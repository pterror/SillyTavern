import * as v from 'valibot';

export type ViewFrame =
    | { key: string; version: number; value: unknown }
    | { key: string; version: number; patch: unknown };

export type ActionAnswer = { ok: true; views: ViewFrame[] } | { ok: false; error: string; views: ViewFrame[] };

export type ViewPush = { type: 'views'; views: ViewFrame[] };

export type ActionSchemas = Record<string, v.GenericSchema>;

const chatOwner = v.union([
    v.object({ avatar: v.pipe(v.string(), v.minLength(1)) }),
    v.object({ group: v.pipe(v.string(), v.minLength(1)) }),
]);

export type ChatOwner = v.InferOutput<typeof chatOwner>;

export const viewActions = {
    'view.open': v.object({ key: v.string() }),
    'view.close': v.object({ key: v.string() }),
    'chat.show': chatOwner,
    'chat.close': v.object({}),
} satisfies ActionSchemas;

export type Payload<S extends ActionSchemas, T extends keyof S> = v.InferInput<S[T]>;

export type Action<S extends ActionSchemas> = { [T in keyof S & string]: { type: T; payload: Payload<S, T> } }[keyof S &
    string];

export type ViewTypes = Record<string, unknown>;
