/** @type {(url: string, title: string) => void} */
let showLightbox = null;

/** @param {(url: string, title: string) => void} show */
export function initImageLightbox(show) {
    showLightbox = show;
}

/**
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
 * @param {HTMLElement|JQuery<HTMLElement>} element
 */
export function addImageLightbox(element) {
    $(element).addClass('image_lightbox').on('click', 'img', onLightboxImageClick);
}
