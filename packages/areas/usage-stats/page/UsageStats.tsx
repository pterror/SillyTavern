import { Show, createEffect, createSignal, on, onCleanup } from 'solid-js';
import moment from 'moment';
import { useUi } from '@st/page/context';
import { VIEW } from '../protocol.ts';
import type { Counts, Shown, ShownView } from '../protocol.ts';

export type OldPage = {
    // The avatar of the character the character panel shows.
    shownCharacter(): string | null;
    failed(message: string): void;
    // Called whenever the stats dialog opens, starts closing or has closed, so the old page can keep its toasts above
    // the topmost open dialog.
    dialogsChanged(): void;
};

export type Buttons = { all: HTMLElement; character: HTMLElement };

export function UsageStats(props: { buttons: Buttons; old: OldPage }) {
    const { client, t } = useUi();
    const [opened, setOpened] = createSignal(false);

    const show = async (of: Shown) => {
        const answer = await client.send('usageStats.show', of);
        if (!answer.ok) {
            props.old.failed(t('Stats could not be loaded. Try reloading the page.'));
            return;
        }
        setOpened(true);
    };
    const showAll = () => void show({ of: 'all' });
    const showCharacter = () => {
        const avatar = props.old.shownCharacter();
        if (avatar !== null) void show({ of: 'character', avatar });
    };
    const listen = (button: HTMLElement, click: () => void) => {
        button.addEventListener('click', click);
        onCleanup(() => {
            button.removeEventListener('click', click);
        });
    };
    createEffect(() => {
        listen(props.buttons.all, showAll);
    });
    createEffect(() => {
        listen(props.buttons.character, showCharacter);
    });

    return (
        <Show when={opened()}>
            <Panel old={props.old} onClosed={() => setOpened(false)} />
        </Show>
    );
}

// Mounted only after the first show's answer opened the view, so reading it sends no view.open. Closed by the user,
// it closes at once and tells the server afterwards: what the server answers can't keep it open.
function Panel(props: { old: Pick<OldPage, 'dialogsChanged'>; onClosed: () => void }) {
    const { client, t } = useUi();
    const view = client.view<ShownView>(VIEW);
    const [drawn, setDrawn] = createSignal<Exclude<ShownView, { of: null }> | null>(null);
    let dialog: HTMLDialogElement | undefined;
    let closing = false;

    const animated = (attribute: 'opening' | 'closing', then: () => void) => {
        const element = dialog;
        if (!element) return;
        element.setAttribute(attribute, '');
        const done = () => {
            element.removeAttribute(attribute);
            then();
        };
        if (typeof element.getAnimations !== 'function' || element.getAnimations().length === 0) done();
        else element.addEventListener('animationend', done, { once: true });
    };

    // Whether it started closing the dialog.
    const hide = (): boolean => {
        if (closing || dialog?.open !== true) return false;
        closing = true;
        animated('closing', () => {
            dialog?.close();
            props.old.dialogsChanged();
            props.onClosed();
        });
        props.old.dialogsChanged();
        return true;
    };

    createEffect(
        on(view, (current) => {
            if (current === undefined || closing) return;
            if (current.of === null) {
                hide();
                return;
            }
            setDrawn(current);
            if (dialog && !dialog.open) {
                dialog.showModal();
                props.old.dialogsChanged();
                animated('opening', () => {});
            }
        }),
    );

    const close = () => {
        if (hide()) void client.send('usageStats.close', {});
    };

    return (
        <dialog
            ref={(el: HTMLDialogElement) => (dialog = el)}
            class="popup popup--animation-fast"
            onCancel={(event) => {
                event.preventDefault();
                close();
            }}
        >
            <div class="popup-body">
                <div class="popup-content">
                    <Show when={drawn()}>{(shown) => <Report shown={shown()} />}</Show>
                </div>
                <div class="popup-controls">
                    <button
                        type="button"
                        class="popup-button-ok menu_button menu_button_default"
                        autofocus
                        onClick={close}
                    >
                        {t('OK')}
                    </button>
                </div>
            </div>
            <div
                class="popup-button-close right_menu_button fa-solid fa-circle-xmark"
                title={t('Close popup')}
                onClick={close}
            />
        </dialog>
    );
}

export function generationTime(ms: number): string {
    let rest = Math.floor(ms / 1000);
    const seconds = rest % 60;
    rest = Math.floor(rest / 60);
    const minutes = rest % 60;
    rest = Math.floor(rest / 60);
    const hours = rest % 24;
    const days = Math.floor(rest / 24);
    let text = '';
    if (days > 0) text += `${String(days)} Days, `;
    if (hours > 0) text += `${String(hours)} Hours, `;
    if (minutes > 0) text += `${String(minutes)} Minutes, `;
    return `${text}${String(seconds)} Seconds`;
}

function Block(props: { name: string; value: string | number }) {
    return (
        <div class="rm_stat_block">
            <div class="rm_stat_name">{props.name}:</div>
            <div class="rm_stat_value">{props.value}</div>
        </div>
    );
}

function Report(props: { shown: Exclude<ShownView, { of: null }> }) {
    const { t } = useUi();
    const counts = (): Counts => props.shown.counts;
    const isAll = () => props.shown.of === 'all';
    const kind = () => (isAll() ? t('User', 'stats_header_User') : t('Character', 'stats_header_Character'));
    const since = () => {
        const first = counts().firstChat;
        return first !== null && first > 0 && first < Date.now() ? moment(first).fromNow() : t('Never');
    };
    const time = () => {
        const text = generationTime(counts().generationMs);
        const unknown = counts().repliesWithoutTime;
        return unknown > 0
            ? `${text} ${t('(plus ${0} replies saved without their generation time)').replace('${0}', String(unknown))}`
            : text;
    };
    const oldStatsFile = () => (props.shown.of === 'all' ? props.shown.oldStatsFile : null);
    return (
        <>
            <h3>{t('${0} Stats').replace('${0}', kind())}</h3>
            <Block name={isAll() ? t('Chatting Since') : t('First Interaction')} value={since()} />
            <Block name={t('Chat Time')} value={time()} />
            <Block name={t('User Messages')} value={counts().userMessages} />
            <Block name={t('Character Messages')} value={counts().characterMessages} />
            <Block name={t('User Words')} value={counts().userWords} />
            <Block name={t('Character Words')} value={counts().characterWords} />
            <Block name={t('Swipes')} value={counts().swipes} />
            <Show when={oldStatsFile()}>
                {(file) => (
                    <p>
                        <small>
                            {t(
                                'Your stats from before they were counted from your chats are kept in ${0} in your data folder.',
                            ).replace('${0}', file())}
                        </small>
                    </p>
                )}
            </Show>
        </>
    );
}
