import { onSettled } from 'solid-js';
import { Portal } from '@solidjs/web';
import type { JSX } from '@solidjs/web';
import { float } from '@st/page/popover';

export function Floating(props: { anchor: HTMLElement; close: () => void; class: string; children: JSX.Element }) {
    let element: HTMLDivElement | undefined;
    float(() => element, {
        anchor: () => props.anchor,
        close: () => {
            props.close();
            props.anchor.focus();
        },
        framed: false,
    });
    onSettled(() => {
        element?.querySelector<HTMLInputElement>('input')?.focus();
    });
    return (
        <Portal>
            <div
                ref={(shown) => {
                    element = shown;
                }}
                class={['view_pill_popover', props.class]}
            >
                {props.children}
            </div>
        </Portal>
    );
}
