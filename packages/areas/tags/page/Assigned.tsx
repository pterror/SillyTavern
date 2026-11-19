import { For, Show, createStore, flush, reconcile } from 'solid-js';
import { useUi } from '@st/page/context';
import { nameClass } from '@st/page/name';

export type AssignedTag = {
    id: string;
    name: string;
    thing: string | undefined;
    className: string;
    title: string;
    icon: string;
    removable: boolean;
    inactive: boolean;
    actionable: boolean;
};
export type AssignedView = { tags: AssignedTag[]; skipped: number; expandable?: boolean };
export type AssignedPorts = {
    remove(this: void, id: string): void;
    expand(this: void): void;
    activate(this: void, id: string, element: HTMLElement, event: MouseEvent): void;
};
export function createAssigned() {
    const [state, setState] = createStore<AssignedView>({ tags: [], skipped: 0 });
    return {
        view: () => state,
        show: (view: AssignedView) => {
            flush(() => setState(reconcile(view, 'id')));
        },
    };
}
export function AssignedTags(props: { list: ReturnType<typeof createAssigned>; old: AssignedPorts }) {
    const { t } = useUi();
    return (
        <>
            <For each={props.list.view().tags}>
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
                        onClick={(event) => props.old.activate(tag.id, event.currentTarget, event)}
                    >
                        <span class={['tag_name', tag.icon]}>{tag.icon === '' ? tag.name : ''}</span>
                        <Show when={tag.removable}>
                            <button
                                type="button"
                                class="tag_remove fa-solid fa-circle-xmark"
                                aria-label={`${t('Remove')} ${tag.name}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    props.old.remove(tag.id);
                                }}
                            />
                        </Show>
                    </span>
                )}
            </For>
            <Show when={props.list.view().skipped > 0}>
                <Show
                    when={props.list.view().expandable !== false}
                    fallback={
                        <span class="tag placeholder-expander">
                            <span class="tag_name">...</span>
                        </span>
                    }
                >
                    <button
                        type="button"
                        class="tag placeholder-expander"
                        title={`${props.list.view().skipped} ${t('tags not displayed.')}\n\n${t('Click to expand remaining tags.')}`}
                        onClick={(event) => {
                            event.stopPropagation();
                            props.old.expand();
                        }}
                    >
                        <span class="tag_name">...</span>
                    </button>
                </Show>
            </Show>
        </>
    );
}
