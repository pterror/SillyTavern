// Popovers as browsers have them and happy-dom doesn't: showing and hiding one, and `:popover-open` matching it shown.

const SHOWN = 'data-test-popover-open';

if (typeof HTMLElement.prototype.showPopover !== 'function') {
    const matches = Object.getOwnPropertyDescriptor(Element.prototype, 'matches')?.value as (
        this: Element,
        selectors: string,
    ) => boolean;
    Object.defineProperty(Element.prototype, 'matches', {
        configurable: true,
        writable: true,
        value(this: Element, selectors: string) {
            return matches.call(this, selectors.replaceAll(':popover-open', `[${SHOWN}]`));
        },
    });
    HTMLElement.prototype.showPopover = function (this: HTMLElement) {
        this.setAttribute(SHOWN, '');
    };
    HTMLElement.prototype.hidePopover = function (this: HTMLElement) {
        this.removeAttribute(SHOWN);
    };
}
