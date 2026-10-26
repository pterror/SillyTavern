// Each line marked `expect:` must get exactly those diagnostics; no other line may get any.
import { createSignal } from 'solid-js';
import { thing } from '../../../../public/script.js'; // expect: st(declared-imports)
import other from 'not-declared'; // expect: st(declared-imports)
export let counter = 0; // expect: st(no-module-state)
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
        </div>
    );
}
