import { Show } from 'solid-js';
import { useUi } from '@st/page/context';
import { TagChips } from '@st/page/tags';
import type { Controls, ControlPorts } from './controls.ts';

/** Selected folder filters; removing one leaves the other selections intact. */
export function FolderBreadcrumbs(props: { controls: Controls; old: ControlPorts }) {
    const { t } = useUi();
    return (
        <Show when={props.controls.tags().folders.length > 0}>
            <nav class="tags rm_tag_bogus_drilldown" aria-label={t('Folder filters')} data-solid-tags="">
                <TagChips
                    view={{ tags: props.controls.tags().folders, skipped: 0 }}
                    actions={{
                        remove: props.old.removeFolder,
                        activate() {},
                        expand() {},
                    }}
                />
            </nav>
        </Show>
    );
}
