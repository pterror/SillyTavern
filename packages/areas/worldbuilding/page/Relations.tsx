import { For, Show, createEffect, createSignal, on, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { FOUND_VIEW, LAST_CHANGE_VIEW, LOOP_CHECK_VISITS_PER_WRITE } from '../protocol.ts';
import type { FoundView, LastChangeView, OpenEntryView, RelationKind } from '../protocol.ts';
import { useWb } from './context.ts';
import { dismissOn } from './dismiss.ts';
import { shownView } from './views.ts';

export function RelationsLine(props: {
    entry: OpenEntryView;
    worldName: string;
    kinds: RelationKind[];
    onWorld: () => void;
}) {
    const { t } = useUi();
    const wb = useWb();
    const [adding, setAdding] = createSignal(false);
    let button: HTMLButtonElement | undefined;
    return (
        <div class="wb-rels">
            <button type="button" class="wb-rels-world" onClick={() => props.onWorld()}>
                {props.worldName}
            </button>
            <For each={props.entry.relations.filter((relation) => !relation.targetDeleted)}>
                {(relation) => (
                    <span class="wb-rel">
                        <span>{relation.kindName ?? ''}:</span>
                        <button type="button" class="wb-rel-target" onClick={() => wb.open(relation.targetEntry)}>
                            {relation.target?.text ?? ''}
                        </button>
                    </span>
                )}
            </For>
            <button
                ref={(element) => (button = element)}
                type="button"
                class="wb-rels-add"
                aria-expanded={adding()}
                onClick={() => setAdding(!adding())}
            >
                {t('+ relation')}
            </button>
            <Show when={adding()}>
                <NewRelation
                    entry={props.entry}
                    kinds={props.kinds}
                    opener={() => button}
                    onClose={() => setAdding(false)}
                />
            </Show>
        </div>
    );
}

function NewRelation(props: {
    entry: OpenEntryView;
    kinds: RelationKind[];
    opener: () => HTMLElement | undefined;
    onClose: () => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const found = shownView<FoundView>(client, FOUND_VIEW);
    const lastChange = shownView<LastChangeView>(client, LAST_CHANGE_VIEW);
    const pickable = () => props.kinds.filter((kind) => kind.mergingInto === null);
    const [kind, setKind] = createSignal<string | null>(pickable()[0]?.id ?? null);
    const [query, setQuery] = createSignal('');
    const [madeKind, setMadeKind] = createSignal(false);
    let box: HTMLDivElement | undefined;
    let target: HTMLInputElement | undefined;
    dismissOn(() => box, props.onClose, props.opener);
    createEffect(
        on(
            () => lastChange()?.createdKind,
            (created) => {
                if (!madeKind() || !created || created.book !== props.entry.book) return;
                setMadeKind(false);
                setKind(created.kind);
                target?.focus();
            },
        ),
    );
    onMount(() => target?.focus());
    const typed = (text: string) => {
        setQuery(text);
        if (text.trim() !== '') void wb.act('worldbuilding.findEntries', { book: props.entry.book, query: text });
    };
    const results = () => {
        const shown = found();
        if (!shown || shown.book === null || query().trim() === '' || shown.query !== query()) return [];
        return shown.entries.filter((entry) => entry.thing !== props.entry.entry);
    };
    const relate = (targetEntry: string) => {
        const chosen = kind();
        if (chosen === null) return;
        const relation = {
            book: props.entry.book,
            entry: props.entry.entry,
            kind: chosen,
            target: targetEntry,
            after: null,
            before: null,
            weak: false,
            loopCheckLimit: LOOP_CHECK_VISITS_PER_WRITE,
        };
        props.onClose();
        void wb.act('worldbuilding.addRelation', relation);
    };
    return (
        <div class="wb-relpop" role="dialog" aria-label={t('New relation')} ref={(element) => (box = element)}>
            <div class="wb-relpop-row">
                <span class="wb-relpop-name">{props.entry.label.text}</span>
                <span class="wb-relpop-kinds">
                    <For each={pickable()}>
                        {(item) => (
                            <button
                                type="button"
                                classList={{ 'wb-on': kind() === item.id }}
                                aria-pressed={kind() === item.id}
                                onClick={() => setKind(item.id)}
                            >
                                {item.name}
                            </button>
                        )}
                    </For>
                    <input
                        class="wb-relpop-field"
                        placeholder={t('other…')}
                        aria-label={t('Another relation')}
                        onKeyDown={(event) => {
                            const name = event.currentTarget.value.trim();
                            if (event.key !== 'Enter' || name === '') return;
                            event.currentTarget.value = '';
                            setMadeKind(true);
                            void wb.act('worldbuilding.createRelationKind', { book: props.entry.book, name });
                        }}
                    />
                </span>
                <input
                    ref={(element) => (target = element)}
                    class="wb-relpop-field wb-relpop-wide"
                    placeholder={t('Which entry')}
                    aria-label={t('Which entry')}
                    value={query()}
                    onInput={(event) => typed(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        const first = results()[0];
                        if (event.key === 'Enter' && first) relate(first.thing);
                    }}
                />
            </div>
            <Show when={results().length > 0}>
                <div class="wb-relpop-found" role="listbox" aria-label={t('Entries')}>
                    <For each={results()}>
                        {(entry) => (
                            <button type="button" role="option" class="wb-choice" onClick={() => relate(entry.thing)}>
                                {entry.text}
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
