import { createEffect } from 'solid-js';
import { VIEW, CHAT_VIEW, FITTINGS } from '../protocol.ts';
import type { BackgroundsView, ChatBackgroundsView } from '../protocol.ts';
import { useUi } from '@st/page/context';

export function BackgroundLayer(props: { element: HTMLElement }) {
    const { client } = useUi();
    const view = client.view<BackgroundsView>(VIEW);
    const chatView = client.view<ChatBackgroundsView>(CHAT_VIEW);
    createEffect(() => {
        const shown = chatView()?.shown;
        if (shown) props.element.style.backgroundImage = `url("${shown.url}")`;
    });
    createEffect(() => {
        const fitting = view()?.options.fitting;
        if (fitting !== undefined) for (const each of FITTINGS) props.element.classList.toggle(each, each === fitting);
    });
    return null;
}

export function AnimationOption() {
    const { client, t } = useUi();
    const view = client.view<BackgroundsView>(VIEW);
    return (
        <label
            for="animated_thumbnails"
            class="checkbox_label"
            title={t(
                'Show animated images (characters, personas, backgrounds) moving in every list. Off shows their first frame.',
            )}
        >
            <input
                id="animated_thumbnails"
                type="checkbox"
                checked={view()?.options.animatedThumbnails ?? true}
                onChange={(event) => {
                    const box = event.currentTarget;
                    void client
                        .send('backgrounds.options', { animatedThumbnails: box.checked })
                        .then((result) => result.ok || (box.checked = view()?.options.animatedThumbnails ?? true));
                }}
            />
            <small>{t('Animated thumbnails')}</small>
        </label>
    );
}
