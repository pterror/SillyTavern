// Each line marked `expect:` must get exactly those diagnostics; no other line may get any.
import { createSignal } from 'solid-js';
import { Show } from 'solid-js'; // expect: eslint(no-restricted-imports)
import { thing } from '../../../../public/script.js'; // expect: st(declared-imports)
import other from 'not-declared'; // expect: st(declared-imports)
export let counter = 0; // expect: st(no-module-state)
function Child(props: { onPick: (file: string) => void; onClose: (...rest: unknown[]) => void }) {
    const { onPick } = props; // expect: st(reactive-in-arrow)
    const close = props.onClose; // expect: st(reactive-in-arrow)
    void onPick;
    void close;
    return <i onClick={(event) => props.onPick(String(event.button))} />;
}
export function Bad(props: { label: string; html: string }) {
    const [count] = createSignal(0);
    const node = document.createElement('div');
    node.innerHTML = props.html; // expect: st(no-html-strings)
    node.insertAdjacentHTML('beforeend', props.html); // expect: st(no-html-strings)
    setTimeout(() => counter++, 10); // expect: eslint(no-restricted-globals)
    void fetch('/api'); // expect: eslint(no-restricted-globals)
    localStorage.setItem('a', 'b'); // expect: eslint(no-restricted-globals)
    return (
        <div title={props.label}>{/* expect: st(reactive-in-arrow) */}
            <span {...props} />{/* expect: st(reactive-in-arrow) */}
            {count()}{/* expect: st(reactive-in-arrow) */}
            {count() > 0 ? 'some' : 'none'}{/* expect: st(reactive-in-arrow) */}
            {[thing, other]}{/* expect: st(reactive-in-arrow) */}
            <Child onPick={(file) => file} onClose={() => counter} />{/* expect: st(reactive-in-arrow) */}
            <Child onPick={(file = '') => file} onClose={(...rest) => rest} />{/* expect: st(reactive-in-arrow) expect: st(reactive-in-arrow) */}
            <Child onPick={String} onClose={(event: unknown) => event} />{/* expect: st(reactive-in-arrow) */}
            <Show when={count} fallback={<b />}>{/* expect: st(reactive-in-arrow) */}
                <p />{/* expect: st(reactive-in-arrow) */}
                <><i /></>{/* expect: st(reactive-in-arrow) */}
            </Show>
        </div>
    );
}
