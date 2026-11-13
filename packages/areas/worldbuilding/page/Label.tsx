import { Match, Switch } from 'solid-js';
import { Name } from '@st/page/name';
import type { Named } from '../protocol.ts';

export function Label(props: { named: Named }) {
    return (
        <Switch>
            <Match when={props.named.shownAs === 'name'}>
                <Name named={props.named} />
            </Match>
            <Match when={props.named.shownAs === 'title'}>
                <span>{props.named.text}</span>
            </Match>
            <Match when={props.named.shownAs === 'opening'}>
                <span class="wb-opening">{props.named.text}</span>
            </Match>
        </Switch>
    );
}

export function Picture(props: { url: string | null; class: string }) {
    return (
        <span
            class={props.class}
            style={props.url === null ? undefined : { 'background-image': `url(${JSON.stringify(props.url)})` }}
            aria-hidden="true"
        />
    );
}
