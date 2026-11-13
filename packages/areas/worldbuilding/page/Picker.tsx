import { For, Show, createSignal, onMount } from 'solid-js';
import { useUi } from '@st/page/context';
import { FOUND_VIEW } from '../protocol.ts';
import type { FoundEntry, FoundView } from '../protocol.ts';
import { Label, Picture } from './Label.tsx';
import { useWb } from './context.ts';
import { Icon } from './icons.tsx';
import { shownView } from './views.ts';

// Where a found entry sits under the grouping kind: "in Saltmarrow", its first live relation of that kind.
export function whereItSits(found: FoundEntry, kind: string | null): string {
    if (kind === null) return '';
    const relation = found.relations.find((one) => one.kind === kind && !one.targetDeleted && one.target !== null);
    return relation?.target ? `${relation.kindName ?? ''} ${relation.target.text}` : '';
}

export function TargetPicker(props: {
    heading: string;
    book: string;
    kind: string | null;
    leaveOut: string[];
    class?: string;
    onPick: (entry: string) => void;
}) {
    const { client, t } = useUi();
    const wb = useWb();
    const found = shownView<FoundView>(client, FOUND_VIEW);
    const [query, setQuery] = createSignal('');
    const [at, setAt] = createSignal(0);
    let field: HTMLInputElement | undefined;
    onMount(() => field?.focus());
    const rows = (): FoundEntry[] => {
        const shown = found();
        if (!shown || shown.book !== props.book || query().trim() === '' || shown.query !== query()) return [];
        return shown.entries.filter((entry) => !props.leaveOut.includes(entry.label.thing));
    };
    const typed = (text: string) => {
        setQuery(text);
        setAt(0);
        if (text.trim() !== '') void wb.act('worldbuilding.findEntries', { book: props.book, query: text });
    };
    return (
        <div class={`wb-pick ${props.class ?? ''}`} role="dialog" aria-label={props.heading}>
            <div class="wb-pick-head">{props.heading}</div>
            <label class="wb-pick-field text_pole margin0">
                <Icon name="search" size={15} />
                <input
                    ref={(element) => (field = element)}
                    aria-label={props.heading}
                    value={query()}
                    onInput={(event) => typed(event.currentTarget.value)}
                    onKeyDown={(event) => {
                        const shown = rows();
                        if (event.key === 'ArrowDown') setAt(Math.min(shown.length - 1, at() + 1));
                        else if (event.key === 'ArrowUp') setAt(Math.max(0, at() - 1));
                        else if (event.key === 'Enter') {
                            const chosen = shown[at()];
                            if (chosen) props.onPick(chosen.label.thing);
                        } else return;
                        event.preventDefault();
                    }}
                />
            </label>
            <Show when={rows().length > 0}>
                <div class="wb-pick-rows list-group" role="listbox" aria-label={t('Entries')}>
                    <For each={rows()}>
                        {(row, index) => (
                            <button
                                type="button"
                                role="option"
                                class="list-group-item wb-pick-row"
                                classList={{ 'wb-on': index() === at() }}
                                aria-selected={index() === at()}
                                onPointerEnter={() => setAt(index())}
                                onClick={() => props.onPick(row.label.thing)}
                            >
                                <Picture url={row.picture} class="wb-pick-pic" />
                                <span class="wb-pick-name">
                                    <Label named={row.label} />
                                </span>
                                <span class="wb-pick-where">{whereItSits(row, props.kind)}</span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
