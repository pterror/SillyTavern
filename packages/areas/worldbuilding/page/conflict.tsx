import { For, Show } from 'solid-js';
import { ask } from '@st/page/dialog';
import type { ActionResult } from '@st/page/client';
import type { ConflictField, EntryConflict, EntryVersion } from '../protocol.ts';
import { copies } from './copies.ts';
import type { TextField } from './copies.ts';

const FIELD_WORDS: Record<string, string> = {
    content: 'Content',
    comment: 'Title',
    key: 'Keys',
    keysecondary: 'Secondary triggers',
    selective: 'Secondary triggers',
    selectiveLogic: 'Logic',
    constant: 'Constant',
    disable: 'Disabled',
    vectorized: 'Vectorized',
    position: 'Position',
    depth: 'Depth',
    role: 'Role',
    order: 'Order',
    probability: 'Probability',
    useProbability: 'Probability',
    'characterFilter.isExclude': 'Character filter',
    'characterFilter.names': 'Character filter',
    'characterFilter.tags': 'Character filter',
};

export const isConflict = (answer: unknown): answer is { conflict: EntryConflict } =>
    typeof answer === 'object' && answer !== null && 'conflict' in answer;

const valueWords = (value: unknown, t: (text: string) => string): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.length === 0 ? '—' : value.map((one) => String(one)).join(', ');
    if (typeof value === 'boolean') return value ? t('On') : t('Off');
    return typeof value === 'object' ? JSON.stringify(value) : String(value as string | number);
};

function FieldShown(props: { field: ConflictField; t: (text: string) => string }) {
    return (
        <section class="wb-conflict-field">
            <h4>{props.t(FIELD_WORDS[props.field.field] ?? props.field.field)}</h4>
            <Show
                when={props.field.diff}
                fallback={
                    <dl class="wb-conflict-values">
                        <dt>{props.t('Mine')}</dt>
                        <dd class="wb-diff-mine">{valueWords(props.field.mine, props.t)}</dd>
                        <dt>{props.t('Theirs')}</dt>
                        <dd class="wb-diff-theirs">{valueWords(props.field.theirs, props.t)}</dd>
                    </dl>
                }
            >
                {(diff) => (
                    <>
                        <p class="wb-diff-key">
                            <span class="wb-diff-mine">{props.t('Mine')}</span>
                            <span class="wb-diff-theirs">{props.t('Theirs')}</span>
                        </p>
                        <p class="wb-diff">
                            <For each={diff()}>
                                {(run) => (
                                    <span
                                        classList={{
                                            'wb-diff-mine': run.in === 'mine',
                                            'wb-diff-theirs': run.in === 'theirs',
                                        }}
                                    >
                                        {run.text}
                                    </span>
                                )}
                            </For>
                        </p>
                    </>
                )}
            </Show>
        </section>
    );
}

type Resolved = 'mine' | 'theirs' | { text: string } | null;

async function resolve(conflict: EntryConflict, t: (text: string) => string): Promise<Resolved> {
    const text = conflict.fields.length === 1 ? (conflict.fields[0]?.merged ?? null) : null;
    const picked = await ask(
        {
            kind: 'pick',
            message: t('Changed in another tab'),
            detail: t('Both tabs changed this. Keep which?'),
            body: () => <For each={conflict.fields}>{(field) => <FieldShown field={field} t={t} />}</For>,
            options: [
                { id: 'mine', label: t('Keep mine') },
                { id: 'theirs', label: t('Keep theirs') },
                ...(text === null ? [] : [{ id: 'hand', label: t('Edit merged…') }]),
            ],
        },
        t,
    );
    if (picked === 'mine' || picked === 'theirs') return picked;
    if (picked !== 'hand' || text === null) return null;
    const merged = await ask({ kind: 'input', message: t('Edit merged'), value: text, multiline: true }, t);
    return merged === null ? null : { text: merged };
}

export type EntryEditPayload = { book: string; entry: string; version: EntryVersion | null } & Record<string, unknown>;

// How an edit ended: saved (with the text sent last, for a text field), or the other side kept, as the conflict had it.
export type Edited =
    | { done: 'saved'; text: string | null }
    | { done: 'theirs'; conflict: EntryConflict }
    | { done: 'refused' };

// Sends an entry edit; when another tab changed the same thing since the edit's version, asks which side to keep and
// sends again against the version the refusal named. For a text field (`text`, the payload's key for it), the text is
// kept in the browser's copy until the server has it or the person keeps the other side; dismissing the question keeps
// the copy apart, for the entry's next opening to carry.
export async function editEntry(
    wb: { act: (type: string, payload: unknown) => Promise<ActionResult> },
    t: (text: string) => string,
    type: string,
    payload: EntryEditPayload,
    text?: TextField,
): Promise<Edited> {
    const of = text === undefined ? null : { book: payload.book, entry: payload.entry, field: text };
    let sending = payload;
    const written = () => (text === undefined ? null : (sending[text] as string));
    if (of && payload.version !== null) copies.keep(of, { text: written() ?? '', version: payload.version });
    for (;;) {
        const done: ActionResult = await wb.act(type, sending);
        if (done.ok) {
            if (of) copies.confirm(of, written() ?? '');
            return { done: 'saved', text: written() };
        }
        if (!isConflict(done.answer)) return { done: 'refused' };
        const { conflict } = done.answer;
        const resolved = await resolve(conflict, t);
        if (resolved === 'mine') {
            sending = { ...sending, version: conflict.version };
        } else if (resolved !== null && resolved !== 'theirs' && text !== undefined) {
            sending = { ...sending, [text]: resolved.text, version: conflict.version };
            if (of) copies.keep(of, { text: resolved.text, version: conflict.version });
        } else {
            if (of && resolved === 'theirs') copies.confirm(of, written() ?? '');
            else if (of) copies.setApart(of);
            return { done: 'theirs', conflict };
        }
    }
}
