import * as v from 'valibot';
import type { ActionSchemas } from '@st/protocol';

export const FROM_VIEW = 'references.from';
export const TO_VIEW = 'references.to';
export const ISSUES_VIEW = 'references.issues';
export const SIZES_VIEW = 'references.sizes';

export type Reference = { entry: string; name: string; spans: [number, number][] };

export type FromView = { entry: string | null; references: Reference[]; unresolved: string[]; next: string | null };

export type ToView = {
    entry: string | null;
    references: Reference[];
    unlinked: { entry: string; name: string }[];
    scanned: boolean;
    unresolved: string[];
    next: string | null;
};

export type Issue =
    | { kind: 'never' }
    | { kind: 'shared'; name: string; with: string[] }
    | { kind: 'heavy'; bytes: number; average: number; always: boolean }
    | { kind: 'broken'; why: string };

export type IssuesView = { book: string | null; issues: { entry: string; issues: Issue[] }[]; next: number | null };

export type SizesView = {
    book: string | null;
    bytes: number;
    hash: string;
    entries: number;
    of: { entry: string; bytes: number; hash: string }[];
};

const id = v.pipe(v.string(), v.regex(/^\d+$/));

export const actions = {
    'references.show': v.object({ book: id, entry: v.nullable(id) }),
    'references.page': v.object({
        list: v.picklist(['from', 'to', 'issues']),
        cursor: v.nullable(v.union([v.string(), v.number()])),
    }),
    'references.sizes': v.object({ entries: v.pipe(v.array(id), v.maxLength(1000)) }),
} satisfies ActionSchemas;
