import { For, Show, createSignal } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { InlineTags } from '@st/page/tags';
import type { createBrowser } from './Browser.tsx';
import type { GroupPorts, MemberAction, Row } from './types.ts';

export function GroupRows(props: { browser: ReturnType<typeof createBrowser>; old: GroupPorts }) {
    return (
        <>
            <Show when={props.browser.error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            <For each={props.browser.view().rows}>{(row) => <GroupRow row={row} old={props.old} />}</For>
        </>
    );
}

function GroupRow(props: { row: Row; old: GroupPorts }) {
    const { t } = useUi();
    const [pending, setPending] = createSignal(false);
    const [error, setError] = createSignal('');
    const act = async (action: MemberAction) => {
        if (pending()) return;
        setPending(true);
        setError('');
        try {
            await props.old.action(props.row.entity, action);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
            setPending(false);
        }
    };
    const action = (name: MemberAction, title: string, icon: string) => (
        <button
            type="button"
            data-action={name}
            title={t(title)}
            aria-label={t(title)}
            class={`right_menu_button fa-solid ${icon}`}
            disabled={pending()}
            onClick={(event) => {
                event.stopPropagation();
                void act(name);
            }}
        />
    );
    return (
        <div
            class={[
                'group_member look-scope',
                {
                    is_fav: props.row.favorite,
                    disabled: props.row.member?.disabled,
                    is_queued: (props.row.member?.queue ?? 0) > 1,
                    is_active: props.row.member?.queue === 1,
                },
            ]}
            data-id={props.row.entity}
            data-avatar={props.row.entity}
        >
            <div class="avatar">
                <img src={props.row.image} title={props.row.entity} alt={props.row.name} loading="lazy" />
            </div>
            <div class="group_member_name">
                <div class="character_name_block">
                    <span class="ch_name">
                        <Show when={props.row.thing !== ''} fallback={props.row.name}>
                            <Name named={{ thing: props.row.thing, text: props.row.name, shownAs: 'name' }} />
                        </Show>
                    </span>
                    <Show when={props.row.auxiliary !== ''}>
                        <small class="ch_additional_info character_version">{props.row.auxiliary}</small>
                    </Show>
                </div>
                <InlineTags tags={props.row.tags} />
                <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
            </div>
            <input class="ch_fav" value={String(props.row.favorite)} hidden />
            <div class="queue_position">{(props.row.member?.queue ?? 0) > 0 ? props.row.member?.queue : ''}</div>
            <div class="group_member_icon">
                <Show when={props.row.member?.existingGroup === true}>
                    {action(
                        'disable',
                        'Temporarily disable automatic replies from this character',
                        'fa-lg fa-comment-slash',
                    )}
                    {action('enable', 'Enable automatic replies from this character', 'fa-lg fa-comment-slash')}
                    {action('speak', 'Trigger a message from this character', 'fa-lg fa-comment')}
                </Show>
                <div class="flexFlowColumn flex-container">
                    {action('up', 'Move up', 'fa-chevron-up')}
                    {action('down', 'Move down', 'fa-chevron-down')}
                </div>
                {action('view', 'View character card', 'fa-xl fa-image-portrait')}
                {action('remove', 'Remove from group', 'fa-xl fa-xmark')}
                {action('add', 'Add to group', 'fa-xl fa-plus')}
            </div>
        </div>
    );
}
