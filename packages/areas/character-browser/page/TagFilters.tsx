import { For, Show } from 'solid-js';
import { useUi } from '@st/page/context';
import { nameClass } from '@st/page/name';
import type { Controls, ControlPorts } from './controls.ts';

export function TagFilters(props: { controls: Controls; old: ControlPorts }) {
    const { t } = useUi();
    const state = () => props.controls.tags();
    return (
        <>
            <For each={state().tags}>
                {(tag) => (
                    <span
                        id={tag.id}
                        role="button"
                        tabindex={0}
                        data-thing={tag.thing}
                        data-toggle-state={tag.state}
                        class={[
                            'tag interactable-control',
                            tag.className,
                            tag.thing === undefined ? '' : nameClass({ thing: tag.thing, shownAs: 'name' }),
                            {
                                actionable: tag.action,
                                'clickable-action': tag.action,
                                selected: tag.state === 'SELECTED',
                                excluded: tag.state === 'EXCLUDED',
                                indicator:
                                    tag.className.includes('showTagList') &&
                                    state().tags.some((each) => !each.action && each.state !== 'UNDEFINED'),
                            },
                        ]}
                        style={{ display: tag.action ? undefined : state().visible ? 'inline-flex' : 'none' }}
                        title={tag.title}
                        onClick={(event) => {
                            void props.old.tagAction(tag.id, event.currentTarget, event);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                event.stopPropagation();
                                event.currentTarget.click();
                            }
                        }}
                    >
                        <span
                            class={['tag_name', tag.icon]}
                            title={tag.icon === '' ? undefined : `${t(tag.name)} ${tag.title}`.trim()}
                        >
                            {tag.icon === '' ? tag.name : ''}
                        </span>
                        <i class="fa-solid fa-circle-xmark tag_remove" style={{ display: 'none' }} />
                    </span>
                )}
            </For>
            <Show when={state().tail !== null && state().visible}>
                <span
                    role="button"
                    tabindex={0}
                    class="tag placeholder-expander interactable-control"
                    style={{ display: 'inline-flex' }}
                    title={t('More tags are not displayed.')}
                    onClick={(event) => {
                        props.old.moreTags(event.currentTarget, state().tail === 'failed');
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.currentTarget.click();
                        }
                    }}
                >
                    <span class="tag_name">
                        {state().tail === 'failed' ? t('Tags could not be loaded. Try again') : '...'}
                    </span>
                </span>
            </Show>
        </>
    );
}
