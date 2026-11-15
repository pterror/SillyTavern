// Popovers and modal dialogs as browsers have them and happy-dom doesn't: showing and hiding a popover, with its
// `beforetoggle` before, `:popover-open` matching it shown, and `:modal` matching a dialog shown modal.

const SHOWN = 'data-test-popover-open';
const MODAL = 'data-test-modal';

const toggle = (element: HTMLElement, newState: 'open' | 'closed') =>
    element.dispatchEvent(
        Object.assign(new Event('beforetoggle'), { newState, oldState: newState === 'open' ? 'closed' : 'open' }),
    );

if (typeof HTMLElement.prototype.showPopover !== 'function') {
    const matches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches')?.value as (
        this: Element,
        selectors: string,
    ) => boolean;
    Object.defineProperty(Element.prototype, 'matches', {
        configurable: true,
        writable: true,
        value(this: Element, selectors: string) {
            return matches.call(
                this,
                selectors.replaceAll(':popover-open', `[${SHOWN}]`).replaceAll(':modal', `[${MODAL}]`),
            );
        },
    });
    HTMLElement.prototype.showPopover = function (this: HTMLElement) {
        toggle(this, 'open');
        this.setAttribute(SHOWN, '');
    };
    HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
        toggle(this, 'closed');
        this.removeAttribute(SHOWN);
    };
    const method = (name: 'showModal' | 'close') =>
        Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)?.value as (
            this: HTMLDialogElement,
            ...args: unknown[]
        ) => void;
    const showModal = method('showModal');
    const close = method('close');
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
        showModal.call(this);
        this.setAttribute(MODAL, '');
    };
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, value?: string) {
        this.removeAttribute(MODAL);
        close.call(this, value);
    };
}
