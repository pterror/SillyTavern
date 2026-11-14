import { For, Show } from 'solid-js';
import { useUi } from '@st/page/context';
import { WORLDS_VIEW } from '../protocol.ts';
import type { WorldsView } from '../protocol.ts';
import { openedView } from './views.ts';

export function WorldChoice(props: { heading: string; from: string; onPick: (book: string, name: string) => void }) {
    const { client, t } = useUi();
    const worlds = openedView<WorldsView>(client, WORLDS_VIEW);
    const others = () => (worlds()?.worlds ?? []).filter((world) => world.id !== props.from);
    return (
        <>
            <div class="wb-menu-head">{props.heading}</div>
            <For each={others()}>
                {(world) => (
                    <button
                        class="list-group-item"
                        type="button"
                        role="menuitem"
                        onClick={() => props.onPick(world.id, world.name)}
                    >
                        {world.name}
                    </button>
                )}
            </For>
            <Show when={worlds() !== undefined && others().length === 0}>
                <div class="wb-menu-head">{t('There is no other world.')}</div>
            </Show>
        </>
    );
}
