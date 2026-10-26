import { render } from 'solid-js/web';

/** Mounts a surface of the new page into one container the old page gives up. */
export function mount(container: HTMLElement, surface: () => HTMLElement): () => void {
    return render(surface, container);
}
