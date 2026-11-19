import { For, Show, createSignal } from 'solid-js';
import { useUi } from './context.ts';
import { nameClass } from './name.tsx';

export type TagChip = {
    id: string;
    name: string;
    thing: string | undefined;
    className: string;
    title: string;
    icon: string;
    removable: boolean;
    inactive: boolean;
    actionable: boolean;
    mandatory?: boolean;
};
export type TagChipsView = { tags: TagChip[]; skipped: number; expandable?: boolean };
export type TagChipsPorts = {
    remove(this: void, id: string): void;
    expand(this: void): void;
    activate(this: void, id: string, element: HTMLElement, event: MouseEvent): void;
};
export function TagChips(props: { view: TagChipsView; actions: TagChipsPorts }) {
    const { t } = useUi();
    return (
        <>
            <For each={props.view.tags}>
                {(tag) => (
                    <span
                        id={tag.id}
                        data-thing={tag.thing}
                        class={[
                            'tag',
                            tag.className,
                            tag.thing === undefined ? '' : nameClass({ thing: tag.thing, shownAs: 'name' }),
                            { 'tag-absent': tag.inactive, 'clickable-action': tag.actionable },
                        ]}
                        title={tag.title === '' ? undefined : tag.title}
                        onMouseEnter={(event) => {
                            if (tag.title !== '') return;
                            const element = event.currentTarget;
                            const name = element.querySelector<HTMLElement>('.tag_name');
                            if (name && name.scrollWidth > name.clientWidth) element.title = tag.name;
                            else element.removeAttribute('title');
                        }}
                        onClick={(event) => props.actions.activate(tag.id, event.currentTarget, event)}
                    >
                        <span class={['tag_name', tag.icon]}>{tag.icon === '' ? tag.name : ''}</span>
                        <Show when={tag.removable}>
                            <button
                                type="button"
                                class="tag_remove fa-solid fa-circle-xmark"
                                aria-label={`${t('Remove')} ${tag.name}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    props.actions.remove(tag.id);
                                }}
                            />
                        </Show>
                    </span>
                )}
            </For>
            <Show when={props.view.skipped > 0}>
                <Show
                    when={props.view.expandable !== false}
                    fallback={
                        <span class="tag placeholder-expander">
                            <span class="tag_name">...</span>
                        </span>
                    }
                >
                    <button
                        type="button"
                        class="tag placeholder-expander"
                        title={`${props.view.skipped} ${t('tags not displayed.')}\n\n${t('Click to expand remaining tags.')}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            props.actions.expand();
                        }}
                    >
                        <span class="tag_name">...</span>
                    </button>
                </Show>
            </Show>
        </>
    );
}

/** Expansion belongs to the row lifecycle, rather than a separately mounted root. */
export function InlineTags(props: { tags: readonly TagChip[] }) {
    const [expanded, setExpanded] = createSignal(false);
    const visible = () => {
        if (expanded()) return props.tags;
        let slots = Math.max(50 - props.tags.filter((tag) => tag.mandatory === true).length, 0);
        return props.tags.filter((tag) => tag.mandatory === true || slots-- > 0);
    };
    return (
        <div class="tags tags_inline" data-solid-tags="">
            <TagChips
                view={{ tags: [...visible()], skipped: props.tags.length - visible().length }}
                actions={{
                    remove() {},
                    activate() {},
                    expand() {
                        setExpanded(true);
                    },
                }}
            />
        </div>
    );
}
