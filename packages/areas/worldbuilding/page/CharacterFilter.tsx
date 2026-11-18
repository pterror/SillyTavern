import { For, Show, createSignal, onSettled } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import type { Named } from '@st/page/name';
import { CHARACTERS_FOUND_VIEW } from '../protocol.ts';
import type { CharacterFilterShown, CharactersFoundView, FilterItem } from '../protocol.ts';
import { Picture } from './Label.tsx';
import { useWb } from './context.ts';
import { Icon } from './icons.tsx';
import { shownView } from './views.ts';
import { fill } from './words.ts';

export type FilterChange = { exclude: boolean } | { add: FilterItem } | { remove: FilterItem };

export const filterIsSet = (filter: CharacterFilterShown): boolean =>
    filter.characters.length + filter.tags.length + filter.more > 0;

export function CharacterFilterSentence(props: {
    filter: CharacterFilterShown;
    adding: boolean;
    onChange: (change: FilterChange) => void;
    onAdding: (adding: boolean) => void;
}) {
    const { t } = useUi();
    const [which, setWhich] = createSignal(false);
    return (
        <p class="wb-filter">
            <button
                type="button"
                class="wb-tok"
                aria-expanded={which() ? 'true' : 'false'}
                onClick={() => setWhich(!which())}
            >
                {props.filter.exclude ? t('Not for ') : t('Only for ')}
            </button>
            <Show when={which()}>
                <span class="list-group st-floating wb-choices" role="listbox" aria-label={t('Character filter')}>
                    <For each={[false, true]}>
                        {(exclude) => (
                            <button
                                type="button"
                                role="option"
                                class={['list-group-item wb-choice', { 'wb-on': props.filter.exclude === exclude }]}
                                aria-selected={props.filter.exclude === exclude ? 'true' : 'false'}
                                onClick={() => {
                                    setWhich(false);
                                    if (props.filter.exclude !== exclude) props.onChange({ exclude });
                                }}
                            >
                                {exclude ? t('All except these characters') : t('Only these characters')}
                            </button>
                        )}
                    </For>
                </span>
            </Show>
            <For each={props.filter.characters}>
                {(character) => (
                    <span class="tag wb-key wb-filter-item">
                        <Show when={character.named} fallback={<span class="wb-key-trigger">{character.key}</span>}>
                            {(named) => <Name named={named()} />}
                        </Show>
                        <button
                            type="button"
                            class="wb-filter-remove"
                            aria-label={fill(t('Remove ${0}'), character.named?.text ?? character.key)}
                            onClick={() => props.onChange({ remove: { character: character.key } })}
                        >
                            ×
                        </button>
                    </span>
                )}
            </For>
            <For each={props.filter.tags}>
                {(tag) => (
                    <span class="tag wb-key wb-filter-item">
                        <span class="wb-key-trigger">
                            <TagName named={tag.named} fallback={tag.key} />
                        </span>
                        <button
                            type="button"
                            class="wb-filter-remove"
                            aria-label={fill(t('Remove ${0}'), tag.named?.text ?? tag.key)}
                            onClick={() => props.onChange({ remove: { tag: tag.key } })}
                        >
                            ×
                        </button>
                    </span>
                )}
            </For>
            <Show when={props.filter.more > 0}>
                <span class="wb-key-more">{fill(t('+${0} more'), String(props.filter.more))}</span>
            </Show>
            <button
                type="button"
                class="menu_button margin0 whitespacenowrap wb-key-add"
                aria-expanded={props.adding ? 'true' : 'false'}
                onClick={() => props.onAdding(!props.adding)}
            >
                {t('+ Character or tag')}
            </button>
            <Show when={props.adding}>
                <CharacterPicker
                    leaveOut={[...props.filter.characters.map((c) => c.key), ...props.filter.tags.map((g) => g.key)]}
                    onPick={(item) => {
                        props.onAdding(false);
                        props.onChange({ add: item });
                    }}
                />
            </Show>
        </p>
    );
}

// "Tag: " and the tag's name as the name renderer draws it, or its key when this user has no such tag.
function TagName(props: { named: Named | null; fallback: string }) {
    const { t } = useUi();
    const [before, after] = t('Tag: ${0}').split('${0}');
    return (
        <>
            {before}
            <Show when={props.named} fallback={props.fallback}>
                {(named) => <Name named={named()} />}
            </Show>
            {after}
        </>
    );
}

type Row = { item: FilterItem; key: string };

function CharacterPicker(props: { leaveOut: string[]; onPick: (item: FilterItem) => void }) {
    const { client, focusActions, t } = useUi();
    const wb = useWb();
    const found = shownView<CharactersFoundView>(client, CHARACTERS_FOUND_VIEW);
    const [query, setQuery] = createSignal('');
    const [at, setAt] = createSignal(0);
    let field: HTMLInputElement | undefined;
    onSettled(() => {
        if (!field) return;
        field.focus();
        return focusActions.attach(field, {
            next: () => void setAt(Math.min(rows().length - 1, at() + 1)),
            previous: () => void setAt(Math.max(0, at() - 1)),
            confirm: () => {
                const chosen = rows()[at()];
                if (chosen) props.onPick(chosen.item);
            },
        });
    });
    const shown = () => {
        const view = found();
        return view && view.query !== null && query().trim() !== '' && view.query === query() ? view : null;
    };
    const rows = (): Row[] => {
        const view = shown();
        if (!view) return [];
        return [
            ...view.characters.map((c) => ({ item: { character: c.key }, key: c.key })),
            ...view.tags.map((g) => ({ item: { tag: g.key }, key: g.key })),
        ].filter((row) => !props.leaveOut.includes(row.key));
    };
    const typed = (text: string) => {
        setQuery(text);
        setAt(0);
        if (text.trim() !== '') void wb.act('worldbuilding.findCharacters', { query: text });
    };
    const heading = t('Character or tag');
    return (
        <span class="wb-pick wb-filter-pick" role="dialog" aria-label={heading}>
            <label class="wb-pick-field text_pole margin0">
                <Icon name="search" size={15} />
                <input
                    ref={(element) => (field = element)}
                    aria-label={heading}
                    value={query()}
                    onInput={(event) => typed(event.currentTarget.value)}
                />
            </label>
            <Show when={rows().length > 0}>
                <span class="wb-pick-rows list-group" role="listbox" aria-label={heading}>
                    <For each={rows()}>
                        {(row, index) => {
                            const character = () => shown()?.characters.find((c) => c.key === row.key) ?? null;
                            const tag = () => shown()?.tags.find((g) => g.key === row.key) ?? null;
                            return (
                                <button
                                    type="button"
                                    role="option"
                                    class={['list-group-item wb-pick-row', { 'wb-on': index() === at() }]}
                                    aria-selected={index() === at() ? 'true' : 'false'}
                                    onPointerEnter={() => setAt(index())}
                                    onClick={() => props.onPick(row.item)}
                                >
                                    <Show
                                        when={'character' in row.item}
                                        fallback={
                                            <span class="wb-pick-name">
                                                <TagName named={tag()?.named ?? null} fallback={row.key} />
                                            </span>
                                        }
                                    >
                                        <Picture url={character()?.picture ?? null} class="wb-pick-pic" />
                                        <span class="wb-pick-name">
                                            <Show when={character()?.named} fallback={row.key}>
                                                {(named) => <Name named={named()} />}
                                            </Show>
                                        </span>
                                    </Show>
                                </button>
                            );
                        }}
                    </For>
                </span>
            </Show>
        </span>
    );
}
