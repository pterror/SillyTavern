import { For, Show, createSignal, onMount } from 'solid-js';
import type { JSX } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { KEY_SHARERS_VIEW, KEY_SUGGESTIONS_VIEW } from '../protocol.ts';
import type { KeySharersView, KeySuggestionsView } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { isPattern, splitKeys } from './keyText.ts';
import { shownView } from './views.ts';
import { count, fill } from './words.ts';

// What the chips are: the entry's names, its keys that only bring it up, or its secondary keys.
export type KeyKind = 'name' | 'trigger' | 'secondary';
export type KeyChip = { text: string; alsoBringsUp?: number };

const WORDS: Record<KeyKind, { chip: string; add: string; field: string }> = {
    name: { chip: '“${0}”, name', add: 'Add name', field: 'Name' },
    trigger: { chip: '“${0}”, trigger', add: 'Add trigger', field: 'Trigger' },
    secondary: { chip: '“${0}”, secondary trigger', add: 'Add secondary trigger', field: 'Secondary trigger' },
};

// The words after the last separator: the key being typed.
const lastWord = (text: string): { before: string; word: string } => {
    const at = Math.max(text.lastIndexOf(','), text.lastIndexOf('\n')) + 1;
    return { before: text.slice(0, at), word: text.slice(at).trimStart() };
};

// An entry's keys of one kind as chips: click one to edit its words in place (Enter keeps them, Escape doesn't), move
// it between names and triggers or remove it; "+" adds keys, several at once when separated by commas or lines.
// `chips` is every key of the kind the entry has; each change is one action.
export function KeyChips(props: {
    book: string;
    entry: string;
    kind: KeyKind;
    chips: KeyChip[];
    // The open entry's page: a key says which other entries it brings up, and asks who they are when opened.
    sharers?: boolean;
    compact?: boolean;
    addWords?: string | undefined;
    // Whether a "+" adds keys; default yes.
    canAdd?: boolean;
}) {
    const { t } = useUi();
    const wb = useWb();
    const [editing, setEditing] = createSignal<string | null>(null);
    const [adding, setAdding] = createSignal(false);
    const at = () => ({ book: props.book, entry: props.entry });
    const texts = () => props.chips.map((chip) => chip.text);
    const secondary = (keysecondary: string[]) =>
        wb.act('worldbuilding.setPlacement', { ...at(), fields: { keysecondary, selective: true } });
    const add = (keys: string[]) => {
        const fresh = keys.filter((key) => !texts().includes(key));
        if (fresh.length === 0) return;
        if (props.kind === 'secondary') void secondary([...texts(), ...fresh]);
        else void wb.act('worldbuilding.addKeys', { ...at(), keys: fresh, as: props.kind });
    };
    const rename = (key: string, to: string) => {
        if (to === '' || to === key) return;
        if (props.kind === 'secondary') {
            void secondary(texts().flatMap((text) => (text === key ? (texts().includes(to) ? [] : [to]) : [text])));
        } else void wb.act('worldbuilding.renameKey', { ...at(), key, to });
    };
    const remove = (key: string) => {
        if (props.kind === 'secondary') void secondary(texts().filter((text) => text !== key));
        else void wb.act('worldbuilding.removeKey', { ...at(), key });
    };
    const move = (key: string, as: 'name' | 'trigger') => void wb.act('worldbuilding.setKeyAs', { ...at(), key, as });
    const edit = (chip: KeyChip) => {
        setAdding(false);
        setEditing(chip.text);
        if (props.sharers === true && (chip.alsoBringsUp ?? 0) > 0)
            void wb.act('worldbuilding.showKeySharers', { ...at(), key: chip.text });
    };
    const words = () => WORDS[props.kind];
    const plusWords = () => props.addWords ?? '+';
    return (
        <>
            <For each={props.chips}>
                {(chip) => (
                    <Show
                        when={editing() === chip.text}
                        fallback={
                            <button
                                type="button"
                                class="tag wb-key"
                                classList={{ 'wb-pattern': isPattern(chip.text), 'wb-compact': props.compact }}
                                aria-label={fill(t(words().chip), chip.text)}
                                title={chip.text}
                                onClick={() => edit(chip)}
                            >
                                <Show
                                    when={props.kind === 'name'}
                                    fallback={<span class="wb-key-trigger">{chip.text}</span>}
                                >
                                    <Name named={{ thing: props.entry, text: chip.text, shownAs: 'name' }} />
                                </Show>
                                <Show when={(chip.alsoBringsUp ?? 0) > 0}>
                                    <span class="wb-key-more">
                                        {fill(t('· ${0} entries'), count((chip.alsoBringsUp ?? 0) + 1))}
                                    </span>
                                </Show>
                            </button>
                        }
                    >
                        <KeyField
                            book={props.book}
                            label={fill(t('Edit “${0}”'), chip.text)}
                            initial={chip.text}
                            taken={texts()}
                            menu={() => (
                                <KeyMenu
                                    kind={props.kind}
                                    chip={chip}
                                    entry={props.entry}
                                    onMove={(as) => {
                                        setEditing(null);
                                        move(chip.text, as);
                                    }}
                                    onRemove={() => {
                                        setEditing(null);
                                        remove(chip.text);
                                    }}
                                    onOpen={() => setEditing(null)}
                                />
                            )}
                            onDone={(value) => {
                                setEditing(null);
                                if (value !== null) rename(chip.text, value.trim());
                            }}
                        />
                    </Show>
                )}
            </For>
            <Show when={props.canAdd !== false}>
                <Show
                    when={adding()}
                    fallback={
                        <button
                            type="button"
                            class="menu_button margin0 whitespacenowrap wb-key-add"
                            classList={{ 'wb-compact': props.compact }}
                            aria-label={t(words().add)}
                            title={t(words().add)}
                            onClick={() => {
                                setEditing(null);
                                setAdding(true);
                            }}
                        >
                            {t(plusWords())}
                        </button>
                    }
                >
                    <KeyField
                        book={props.book}
                        label={t(words().field)}
                        initial=""
                        several
                        taken={texts()}
                        onDone={(value) => {
                            setAdding(false);
                            if (value !== null) add(splitKeys(value));
                        }}
                    />
                </Show>
            </Show>
        </>
    );
}

// The words of one key being typed, with the world's keys that start with them to pick from. `several`: it takes
// several keys, so the suggestions are for the last one. Enter keeps what is typed (or the suggestion arrowed to), and
// Escape drops it; when `several`, leaving the field keeps it too.
function KeyField(props: {
    book: string;
    label: string;
    initial: string;
    several?: boolean;
    taken: string[];
    menu?: () => JSX.Element;
    onDone: (value: string | null) => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const suggested = shownView<KeySuggestionsView>(client, KEY_SUGGESTIONS_VIEW);
    const [value, setValue] = createSignal(props.initial);
    const [at, setAt] = createSignal(-1);
    const [hidden, setHidden] = createSignal(false);
    let field: HTMLInputElement | undefined;
    let finished = false;
    const finish = (text: string | null) => {
        if (finished) return;
        finished = true;
        props.onDone(text);
    };
    const typed = () => (props.several === true ? lastWord(value()) : { before: '', word: value().trimStart() });
    const rows = () => {
        const view = suggested();
        if (hidden() || !view || view.book !== props.book || view.typed !== typed().word) return [];
        return view.suggestions.filter((one) => !props.taken.includes(one.text));
    };
    onMount(() => {
        field?.focus();
        field?.select();
    });
    const picked = (text: string) => {
        finish(`${typed().before}${text}`);
    };
    return (
        <>
            <input
                ref={(element) => (field = element)}
                class="text_pole margin0 wb-key-field"
                aria-label={props.label}
                placeholder={props.label}
                value={props.initial}
                on:input={(event) => {
                    const text = (event.currentTarget as HTMLInputElement).value;
                    setValue(text);
                    setAt(-1);
                    setHidden(false);
                    const { word } = typed();
                    if (word !== '') void wb.act('worldbuilding.suggestKeys', { book: props.book, typed: word });
                }}
                on:paste={(event) => {
                    const pasted = event.clipboardData?.getData('text') ?? '';
                    if (props.several !== true || !/[\r\n]/.test(pasted)) return;
                    event.preventDefault();
                    const input = event.currentTarget as HTMLInputElement;
                    input.setRangeText(
                        pasted.replace(/\s*[\r\n]+\s*/g, ', '),
                        input.selectionStart ?? 0,
                        input.selectionEnd ?? 0,
                        'end',
                    );
                    setValue(input.value);
                }}
                on:keydown={(event) => {
                    const all = rows();
                    if (event.key === 'ArrowDown' && all.length > 0) setAt(Math.min(all.length - 1, at() + 1));
                    else if (event.key === 'ArrowUp' && all.length > 0) setAt(Math.max(-1, at() - 1));
                    else if (event.key === 'Enter') {
                        const chosen = all[at()];
                        if (chosen) picked(chosen.text);
                        else finish((event.currentTarget as HTMLInputElement).value);
                    } else if (event.key === 'Escape') {
                        event.stopPropagation();
                        finish(null);
                    } else return;
                    event.preventDefault();
                }}
                onBlur={(event) => {
                    if (props.several === true) finish(event.currentTarget.value);
                }}
            />
            <Show when={props.menu !== undefined || rows().length > 0}>
                <FieldPopover
                    field={() => field}
                    onClose={() => (props.menu !== undefined ? finish(null) : setHidden(true))}
                >
                    <Show when={rows().length > 0}>
                        <div role="listbox" aria-label={t('Keys in this world')}>
                            <For each={rows()}>
                                {(one, index) => (
                                    <button
                                        type="button"
                                        role="option"
                                        class="list-group-item wb-opt wb-suggestion"
                                        classList={{ 'wb-on': index() === at() }}
                                        aria-selected={index() === at()}
                                        onPointerEnter={() => setAt(index())}
                                        onClick={() => picked(one.text)}
                                    >
                                        <span
                                            class="wb-suggestion-text"
                                            classList={{ 'wb-pattern': isPattern(one.text) }}
                                        >
                                            {one.text}
                                        </span>
                                        <span class="wb-key-more">
                                            {one.keys === 1
                                                ? t('· 1 entry')
                                                : fill(t('· ${0} entries'), count(one.keys))}
                                        </span>
                                    </button>
                                )}
                            </For>
                        </div>
                    </Show>
                    {props.menu?.()}
                </FieldPopover>
            </Show>
        </>
    );
}

function FieldPopover(props: { field: () => HTMLElement | undefined; onClose: () => void; children: JSX.Element }) {
    let box: HTMLDivElement | undefined;
    dismissOn(() => box, props.onClose, props.field);
    return (
        <div
            class="wb-pop"
            role="dialog"
            ref={(element) => (box = element)}
            onMouseDown={(event) => event.preventDefault()}
        >
            {props.children}
        </div>
    );
}

function KeyMenu(props: {
    kind: KeyKind;
    chip: KeyChip;
    entry: string;
    onMove: (as: 'name' | 'trigger') => void;
    onRemove: () => void;
    onOpen: () => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const sharers = shownView<KeySharersView>(client, KEY_SHARERS_VIEW);
    const others = () => {
        const shown = sharers();
        if (!shown || shown.book === null || shown.key !== props.chip.text || shown.entry !== props.entry) return null;
        return shown;
    };
    const target = (): 'name' | 'trigger' | null =>
        props.kind === 'name' ? 'trigger' : props.kind === 'trigger' && !isPattern(props.chip.text) ? 'name' : null;
    return (
        <>
            <Show when={target()}>
                {(as) => (
                    <button type="button" class="list-group-item wb-opt" onClick={() => props.onMove(as())}>
                        <b>{as() === 'name' ? t('Make it a name') : t('Make it a trigger')}</b>
                    </button>
                )}
            </Show>
            <Show when={(props.chip.alsoBringsUp ?? 0) > 0 && others()}>
                {(shown) => (
                    <div class="wb-pop-shared">
                        {t('Also activates ')}
                        <For each={shown().entries}>
                            {(other, n) => (
                                <>
                                    {n() > 0 ? ', ' : ''}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            props.onOpen();
                                            wb.open(other.thing);
                                        }}
                                    >
                                        {other.text}
                                    </button>
                                </>
                            )}
                        </For>
                        <Show when={shown().more}>{t(' and more')}</Show>
                    </div>
                )}
            </Show>
            <button type="button" class="list-group-item wb-pop-remove" onClick={() => props.onRemove()}>
                {t('Remove')}
            </button>
        </>
    );
}
