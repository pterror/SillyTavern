import { useUi } from '@st/page/context';
import type { EntryFacts } from '../protocol.ts';
import { useWb } from './context.ts';
import { switched } from './facts.ts';
import { fill } from './words.ts';

// Switches an entry on or off in one action; off never comes into the prompt.
export function OnOff(props: { book: string; entry: string; name: string; facts: EntryFacts }) {
    const { t } = useUi();
    const wb = useWb();
    const on = () => props.facts.comesIn !== 'never';
    return (
        <button
            type="button"
            role="switch"
            class="wb-onoff fa-solid fa-fw"
            classList={{ 'fa-toggle-on': on(), 'fa-toggle-off': !on(), 'wb-onoff-off': !on() }}
            aria-checked={on()}
            aria-label={fill(t('${0} comes into the prompt'), props.name)}
            title={on() ? t('On: comes into the prompt') : t('Off: never comes into the prompt')}
            onClick={(event) => {
                event.stopPropagation();
                void wb.act('worldbuilding.setPlacement', {
                    book: props.book,
                    entry: props.entry,
                    fields: switched(props.facts),
                });
            }}
        />
    );
}
