// A leaf module: the lightbox is passed to initImageLightbox(), so importing this never adds an import cycle.

/** @type {(url: string, title: string) => void} */
let showLightbox = null;

/** @param {(url: string, title: string) => void} show Shows the image at the URL in the lightbox. */
export function initImageLightbox(show) {
    showLightbox = show;
}

/**
 * Click handler for an image in user-written HTML: shows the image in the lightbox. The click goes no
 * further, so whatever else a click there does (click to edit, dismissing a toast) is left out.
 * An image that is a popup result control keeps its own click and shows no lightbox.
 * @this {HTMLImageElement}
 * @param {JQuery.ClickEvent} event
 */
export function onLightboxImageClick(event) {
    if (this.closest('[data-result]')) {
        return;
    }
    event.stopPropagation();
    showLightbox(this.src, this.alt || '');
}

/**
 * Makes a click on any image inside the element show that image in the lightbox, now and for images
 * added to the element later.
 * @param {HTMLElement|JQuery<HTMLElement>} element Element holding user-written HTML
 */
export function addImageLightbox(element) {
    $(element).on('click', 'img', onLightboxImageClick);
}
