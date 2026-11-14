import { For, Show, onCleanup, onMount } from 'solid-js';
import type { Accessor } from 'solid-js';
import { useUi } from '@st/page/context';
import { Name } from '@st/page/name';
import { LOOK_SCOPE_CLASS } from '@st/protocol/looks';
import { VIEW } from '../protocol.ts';
import type { Cut, Label, Opener, PanelView, Shown, Where } from '../protocol.ts';

export type OldPage = {
    messageNumber(nodeId: string): number | null;
    openEntry(book: string, uid: number): void;
    openCardBook(avatar: string): void;
    panelShown(message: string | null): void;
};

export type Look = { message: string };

export function Activations(props: { look: Look | null; old: OldPage; onClose: () => void }) {
    const { client } = useUi();
    const view = client.view<PanelView>(VIEW);
    return (
        <Show when={props.look} keyed>
            {(look) => <Panel look={look} view={view} old={props.old} onClose={props.onClose} />}
        </Show>
    );
}

function Labelled(props: { label: Label }) {
    return (
        <Show when={props.label.thing !== null && props.label} fallback={props.label.text}>
            {(named) => <Name named={named() as Extract<Label, { shownAs: unknown }>} />}
        </Show>
    );
}

const FIELDS: Record<string, string> = {
    personaDescription: "your persona's description",
    characterDescription: "the character's description",
    characterPersonality: "the character's personality",
    characterDepthPrompt: "the character's note",
    scenario: 'the scenario',
    creatorNotes: "the creator's notes",
};

const INJECTS: Record<string, string> = {
    note: "the author's note",
    quiet: 'the instruction for this reply',
};

function Panel(props: { look: Look; view: Accessor<PanelView | undefined>; old: OldPage; onClose: () => void }) {
    const { client, t } = useUi();
    void client.send('activations.open', { message: props.look.message });
    onCleanup(() => void client.send('activations.close', {}));

    let dialog: HTMLDialogElement | undefined;
    onMount(() => dialog?.showModal());

    const shown = () => {
        const live = props.view();
        return live && live.message === props.look.message ? live : null;
    };

    const where = (place: Where) => {
        if ('message' in place) {
            const n = props.old.messageNumber(place.message);
            return n === null ? t('an earlier message') : t('message #${0}').replace('${0}', String(n));
        }
        if ('field' in place) return t(FIELDS[place.field] ?? 'the character card');
        return t(INJECTS[place.inject] ?? 'an added instruction');
    };

    const reason = (entry: Shown) => {
        switch (entry.why) {
            case 'always':
                return t('Constant');
            case 'sticky':
                return t('Sticky, from an earlier reply');
            case 'decorator':
                return t('Activated by @@activate in its text');
            case 'key': {
                const found = entry.keys.filter((k) => k.where.length > 0);
                if (found.length === 0) return null;
                return found
                    .map((k) =>
                        t('“${0}” in ${1}').replace('${0}', k.key).replace('${1}', k.where.map(where).join(', ')),
                    )
                    .join('; ');
            }
        }
    };

    const cutReason = (cut: Cut) => {
        switch (cut.why) {
            case 'budget':
                return t('Budget full');
            case 'chance':
                return t('Failed probability roll');
            case 'group':
                return t('Another entry in its inclusion group was chosen');
        }
    };

    const open = (opener: Opener) => {
        if (opener === null) return;
        props.onClose();
        if ('card' in opener) props.old.openCardBook(opener.card);
        else props.old.openEntry(opener.book, opener.uid);
    };

    const Title = (p: { label: Label; open: Opener }) => (
        <Show
            when={p.open !== null}
            fallback={
                <span class="activation-title">
                    <Labelled label={p.label} />
                </span>
            }
        >
            <button type="button" class="activation-title activation-open" onClick={() => open(p.open)}>
                <Labelled label={p.label} />
            </button>
        </Show>
    );

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (dialog = el)}
            class="activations"
            aria-label={t('Lorebook entries used for this reply')}
            onCancel={(event) => {
                event.preventDefault();
                props.onClose();
            }}
        >
            <header class="activations-header">
                <h3>{t('Lorebook entries used for this reply')}</h3>
                <button
                    type="button"
                    class="menu_button activations-close fa-solid fa-xmark"
                    title={t('Close')}
                    aria-label={t('Close')}
                    onClick={() => props.onClose()}
                />
            </header>
            <Show when={shown()} fallback={<p class="activations-note">{t('Loading…')}</p>}>
                {(panel) => (
                    <>
                        <Show when={panel().entries.length === 0}>
                            <p class="activations-note">{t('No entries used.')}</p>
                        </Show>
                        <ol class="activations-list">
                            <For each={panel().entries}>
                                {(entry) => (
                                    <li class={`activation ${LOOK_SCOPE_CLASS}`}>
                                        <div class="activation-head">
                                            <Title label={entry.label} open={entry.open} />
                                            <span class="activation-book">
                                                <Labelled label={entry.world} />
                                            </span>
                                        </div>
                                        <Show when={reason(entry)}>
                                            {(text) => <div class="activation-reason">{text()}</div>}
                                        </Show>
                                        <Show when={entry.via.length > 0}>
                                            <div class="activation-via">
                                                {t('Via')}{' '}
                                                <For each={entry.via.flatMap((i) => panel().entries[i] ?? [])}>
                                                    {(by, i) => (
                                                        <>
                                                            {i() > 0 ? ', ' : ''}
                                                            <Labelled label={by.label} />
                                                        </>
                                                    )}
                                                </For>
                                            </div>
                                        </Show>
                                    </li>
                                )}
                            </For>
                        </ol>
                        <Show when={panel().cut.length > 0}>
                            <h4 class="activations-cut-title">{t('Left out')}</h4>
                            <ol class="activations-list activations-cut">
                                <For each={panel().cut}>
                                    {(cut) => (
                                        <li class={`activation ${LOOK_SCOPE_CLASS}`}>
                                            <div class="activation-head">
                                                <Title label={cut.label} open={cut.open} />
                                                <span class="activation-book">
                                                    <Labelled label={cut.world} />
                                                </span>
                                            </div>
                                            <div class="activation-reason">{cutReason(cut)}</div>
                                        </li>
                                    )}
                                </For>
                            </ol>
                        </Show>
                    </>
                )}
            </Show>
        </dialog>
    );
}
