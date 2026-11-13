import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from 'solid-js';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, keymap } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { useUi } from '@st/page/context';
import { Name, nameClass } from '@st/page/name';
import type { TextLink } from '../protocol.ts';

export type Piece = { text: string; link: null } | { text: string; link: string; picture: string | null };

// The text as paragraphs (split at blank lines), each a run of plain pieces and linked names.
export function paragraphsOf(text: string, links: TextLink[]): Piece[][] {
    const sorted = [...links].sort((a, b) => a.from - b.from);
    const paragraphs: Piece[][] = [];
    const breaks = /\n[ \t]*\n\s*/gu;
    let start = 0;
    const cut = (from: number, to: number) => {
        const pieces: Piece[] = [];
        let at = from;
        for (const link of sorted) {
            if (link.to <= from || link.from >= to) continue;
            const linkFrom = Math.max(link.from, from);
            const linkTo = Math.min(link.to, to);
            if (linkFrom > at) pieces.push({ text: text.slice(at, linkFrom), link: null });
            pieces.push({ text: text.slice(linkFrom, linkTo), link: link.entry, picture: link.picture });
            at = linkTo;
        }
        if (at < to) pieces.push({ text: text.slice(at, to), link: null });
        if (pieces.length > 0) paragraphs.push(pieces);
    };
    for (const found of text.matchAll(breaks)) {
        cut(start, found.index);
        start = found.index + found[0].length;
    }
    cut(start, text.length);
    return paragraphs;
}

const linksSet = StateEffect.define<TextLink[]>();

const linkMarks = (links: TextLink[], length: number): DecorationSet => {
    const marks: Range<Decoration>[] = [];
    for (const link of [...links].sort((a, b) => a.from - b.from)) {
        if (link.to > length || link.from >= link.to) continue;
        marks.push(
            Decoration.mark({ class: nameClass({ thing: link.entry, shownAs: 'name' }) }).range(link.from, link.to),
        );
    }
    return Decoration.set(marks, true);
};

// The names stay drawn while the text around them is typed: they move with the edits until the server's links for the
// saved text replace them.
const linked = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(marks, transaction) {
        let next = marks.map(transaction.changes);
        for (const effect of transaction.effects)
            if (effect.is(linksSet)) next = linkMarks(effect.value, transaction.newDoc.length);
        return next;
    },
    provide: (field) => EditorView.decorations.from(field),
});

const gapLine = Decoration.line({ class: 'wb-text-gap' });

const gaps = EditorView.decorations.compute(['doc'], (state) => {
    const builder = new RangeSetBuilder<Decoration>();
    for (let n = 1; n <= state.doc.lines; n++) {
        const line = state.doc.line(n);
        if (line.text.trim() === '' && n > 1 && n < state.doc.lines) builder.add(line.from, line.from, gapLine);
    }
    return builder.finish();
});

const look: Extension = EditorView.theme({
    '&': { fontSize: 'inherit' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit', overflow: 'visible' },
    '.cm-content': { padding: '0', caretColor: 'currentColor' },
    '.cm-line': { padding: '0' },
});

export function EntryText(props: {
    text: string;
    links: TextLink[];
    onSave: (text: string) => Promise<unknown>;
    onEnter: (entry: string, at: HTMLElement) => void;
    onLeave: (event: MouseEvent) => void;
    onOpen: (entry: string) => void;
}) {
    const { t } = useUi();
    const [editing, setEditing] = createSignal(false);
    return (
        <Show
            when={editing()}
            fallback={
                <div
                    class="wb-text"
                    role="textbox"
                    tabIndex={0}
                    aria-label={t('The entry’s text')}
                    onClick={(event) => {
                        if (!(event.target as Element).closest('.wb-link')) setEditing(true);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' && event.target === event.currentTarget) setEditing(true);
                    }}
                >
                    <Show when={props.text.trim() !== ''} fallback={<p class="wb-ghost">{t('Write what this is')}</p>}>
                        <For each={paragraphsOf(props.text, props.links)}>
                            {(pieces) => (
                                <p>
                                    <For each={pieces}>
                                        {(piece) =>
                                            piece.link === null ? (
                                                piece.text
                                            ) : (
                                                <a
                                                    class="wb-link"
                                                    href="#"
                                                    onMouseEnter={(event) =>
                                                        props.onEnter(piece.link, event.currentTarget)
                                                    }
                                                    onMouseLeave={(event) => props.onLeave(event)}
                                                    onClick={(event) => {
                                                        event.preventDefault();
                                                        props.onOpen(piece.link);
                                                    }}
                                                >
                                                    <Name
                                                        named={{ thing: piece.link, text: piece.text, shownAs: 'name' }}
                                                        picture={piece.picture}
                                                    />
                                                </a>
                                            )
                                        }
                                    </For>
                                </p>
                            )}
                        </For>
                    </Show>
                </div>
            }
        >
            <Editor
                text={props.text}
                links={props.links}
                label={t('The entry’s text')}
                onSave={props.onSave}
                onDone={() => setEditing(false)}
            />
        </Show>
    );
}

function Editor(props: {
    text: string;
    links: TextLink[];
    label: string;
    onSave: (text: string) => Promise<unknown>;
    onDone: () => void;
}) {
    let host: HTMLDivElement | undefined;
    let view: EditorView | undefined;
    // The text last sent; saves go one at a time, each sending the text as it is when the one before is answered.
    let sent: string | null = null;
    let saving: Promise<void> = Promise.resolve();
    const sendLatest = async () => {
        const text = view?.state.doc.toString();
        if (text === undefined || text === sent) return;
        sent = text;
        await props.onSave(text);
    };
    const save = (): Promise<void> => (saving = saving.then(sendLatest));
    onMount(() => {
        if (!host) return;
        view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc: props.text,
                extensions: [
                    history(),
                    keymap.of([...defaultKeymap, ...historyKeymap]),
                    EditorView.lineWrapping,
                    EditorView.contentAttributes.of({ 'aria-label': props.label }),
                    linked,
                    gaps,
                    look,
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged) void save();
                    }),
                    EditorView.domEventHandlers({
                        blur: () => {
                            void save().then(() => props.onDone());
                        },
                        keydown: (event) => {
                            if (event.key !== 'Escape') return false;
                            event.stopPropagation();
                            view?.contentDOM.blur();
                            return true;
                        },
                    }),
                ],
            }),
        });
        sent = view.state.doc.toString();
        view.dispatch({ effects: linksSet.of(props.links) });
        view.focus();
    });
    createEffect(
        on(
            () => [props.text, props.links] as const,
            ([text, links]) => {
                if (view && view.state.doc.toString() === text) view.dispatch({ effects: linksSet.of(links) });
            },
            { defer: true },
        ),
    );
    onCleanup(() => view?.destroy());
    return <div class="wb-text wb-text-editing" ref={(element) => (host = element)} />;
}
