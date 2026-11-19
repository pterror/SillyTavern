import { createStore, flush, reconcile } from 'solid-js';
import { TagChips } from '@st/page/tags';
import type { TagChip, TagChipsView, TagChipsPorts } from '@st/page/tags';

export type AssignedTag = TagChip;
export type AssignedView = TagChipsView;
export type AssignedPorts = TagChipsPorts;
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
    return <TagChips view={props.list.view()} actions={props.old} />;
}
