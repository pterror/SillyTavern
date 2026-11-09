import { Show } from 'solid-js';
import {
    LOOK_SELECTED_ATTRIBUTE,
    NAME_BOX_CLASS,
    NAME_PICTURE_CLASS,
    lookBoxClass,
    nameClass,
    namePictureClass,
} from '@st/protocol/looks';
import type { Named } from '@st/protocol/looks';

export { nameClass };
export type { Named };

// `picture`: the thing's small picture where this place draws it beside the name (its look says on which sides).
export type NameOptions = { picture?: string | null; selected?: boolean };

const boxClass = (thing: string) => `${NAME_BOX_CLASS} ${lookBoxClass(thing)}`;
const pictureClass = (side: 'before' | 'after') => `${NAME_PICTURE_CLASS} ${namePictureClass(side)}`;

export function Name(props: { named: Named } & NameOptions) {
    const Picture = (p: { side: 'before' | 'after' }) => (
        <Show when={props.picture}>
            {(src) => <img class={pictureClass(p.side)} src={src()} alt="" loading="lazy" />}
        </Show>
    );
    return (
        <span class={boxClass(props.named.thing)}>
            <Picture side="before" />
            <span
                class={nameClass(props.named)}
                data-thing={props.named.thing}
                {...{ [LOOK_SELECTED_ATTRIBUTE]: props.selected === true ? '' : undefined }}
            >
                {props.named.text}
            </span>
            <Picture side="after" />
        </span>
    );
}

export function nameElement(named: Named, options: NameOptions = {}, document = globalThis.document): HTMLElement {
    const box = document.createElement('span');
    box.className = boxClass(named.thing);
    const picture = (side: 'before' | 'after') => {
        const img = document.createElement('img');
        img.className = pictureClass(side);
        img.src = options.picture ?? '';
        img.alt = '';
        img.loading = 'lazy';
        return img;
    };
    const name = document.createElement('span');
    name.className = nameClass(named);
    name.dataset['thing'] = named.thing;
    if (options.selected === true) name.setAttribute(LOOK_SELECTED_ATTRIBUTE, '');
    name.textContent = named.text;
    if (options.picture !== undefined && options.picture !== null && options.picture !== '')
        box.append(picture('before'), name, picture('after'));
    else box.append(name);
    return box;
}
