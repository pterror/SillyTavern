import { createEffect } from 'solid-js';
import { VIEW, CHAT_VIEW, FITTINGS } from '@st/protocol/backgrounds';
import type { BackgroundsView, ChatBackgroundsView } from '@st/protocol/backgrounds';
import { useUi } from '../../context.ts';

/**
 * The background behind the chat: the old page's `#bg1` element (other old code and themes reach it by id) shows
 * what the view says shows, fitted as the options say.
 */
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
        if (fitting) for (const each of FITTINGS) props.element.classList.toggle(each, each === fitting);
    });
    return null;
}

/** The user settings' "animate backgrounds" option (it changes only how the drawer shows them). */
export function AnimationOption() {
    const { client, t } = useUi();
    const view = client.view<BackgroundsView>(VIEW);
    return (
        <label
            for="background_thumbnails_animation"
            class="checkbox_label"
            title={() => t('Allow animations for WEBP backgrounds. This is only a change for the selection menu.')}
        >
            <input
                id="background_thumbnails_animation"
                type="checkbox"
                checked={() => view()?.options.animation ?? false}
                onChange={(event) => {
                    const box = event.currentTarget;
                    void client.send('backgrounds.options', { animation: box.checked }).then(
                        // Refused: back to what the server has (the view didn't change, so nothing redraws it).
                        (result) => result.ok || (box.checked = view()?.options.animation ?? false),
                    );
                }}
            />
            <small>{() => t('Animated background thumbnails')}</small>
        </label>
    );
}
