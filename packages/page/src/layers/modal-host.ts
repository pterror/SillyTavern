// While a modal dialog is open, every node outside it is inert, the top layer included, so a popover shown then from
// outside it couldn't be used. Every popover the page shows while one is open is moved into the topmost open modal as
// it opens, and back where it was as it closes. A modal that closes or leaves the page with a popover still in it
// gives it back and shows it again: in the next modal down, or where it was.

type Home = { parent: Node; next: Node | null; host: HTMLDialogElement };

const isModal = (element: Element): element is HTMLDialogElement =>
    element instanceof HTMLDialogElement && element.open && element.matches(':modal');

export function hostPopoversInModals(document: Document): () => void {
    const homes = new Map<HTMLElement, Home>();
    // When each open modal opened, in order; one whose `toggle` hasn't come yet opened last.
    const openedAt = new Map<HTMLDialogElement, number>();
    let opened = 0;

    const topModal = (): HTMLDialogElement | null => {
        let top: HTMLDialogElement | null = null;
        let topAt = -1;
        for (const dialog of document.querySelectorAll('dialog')) {
            if (!isModal(dialog)) continue;
            const at = openedAt.get(dialog) ?? Number.MAX_SAFE_INTEGER;
            if (at >= topAt) {
                top = dialog;
                topAt = at;
            }
        }
        return top;
    };

    const watching = new MutationObserver(() => release());

    const goHome = (element: HTMLElement) => {
        const home = homes.get(element);
        if (!home) return;
        homes.delete(element);
        if (homes.size === 0) watching.disconnect();
        if (!home.parent.isConnected) {
            element.remove();
            return;
        }
        home.parent.insertBefore(element, home.next?.parentNode === home.parent ? home.next : null);
    };

    // A popover whose modal is closed or gone goes home and is shown again; one its owner took out is forgotten.
    function release() {
        for (const [element, home] of [...homes]) {
            if (element.parentNode !== home.host) {
                homes.delete(element);
                continue;
            }
            if (home.host.isConnected && isModal(home.host)) continue;
            goHome(element);
            if (element.isConnected) element.showPopover();
        }
        if (homes.size === 0) watching.disconnect();
    }

    const onBeforeToggle = (event: Event) => {
        const element = event.target;
        if (!(element instanceof HTMLElement) || element instanceof HTMLDialogElement || !('newState' in event)) return;
        if (event.newState !== 'open') {
            goHome(element);
            return;
        }
        const modal = topModal();
        if (!modal || modal.contains(element) || element.contains(modal) || !element.parentNode) return;
        if (homes.size === 0) watching.observe(document.documentElement, { childList: true, subtree: true });
        homes.set(element, { parent: element.parentNode, next: element.nextSibling, host: modal });
        modal.append(element);
    };
    const onToggle = (event: Event) => {
        const dialog = event.target;
        if (dialog instanceof HTMLDialogElement && 'newState' in event && event.newState === 'open')
            openedAt.set(dialog, ++opened);
    };
    const onClose = (event: Event) => {
        if (!(event.target instanceof HTMLDialogElement)) return;
        openedAt.delete(event.target);
        release();
    };

    document.addEventListener('beforetoggle', onBeforeToggle, true);
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('close', onClose, true);
    return () => {
        document.removeEventListener('beforetoggle', onBeforeToggle, true);
        document.removeEventListener('toggle', onToggle, true);
        document.removeEventListener('close', onClose, true);
        watching.disconnect();
        for (const element of [...homes.keys()]) goHome(element);
    };
}
