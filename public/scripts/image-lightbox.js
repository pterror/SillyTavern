import { handledInside } from './interactive-content.js';

/** @type {(url: string, title: string) => void} */
let showLightbox = null;

/** @param {(url: string, title: string) => void} show */
export function initImageLightbox(show) {
    showLightbox = show;
}

/**
 * Shows a clicked image in the lightbox, unless what holds it handles the click (a link, a button). The image's
 * double-click is taken too, as its own: the clicks it is made of showed the lightbox.
 * @this {HTMLImageElement}
 * @param {JQuery.ClickEvent | JQuery.DoubleClickEvent} event
 */
export function onLightboxImageClick(event) {
    if (event.isDefaultPrevented() || handledInside(this, event.delegateTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'click') showLightbox(this.src, this.alt || '');
}

/**
 * @param {HTMLElement|JQuery<HTMLElement>} element
 */
export function addImageLightbox(element) {
    $(element).addClass('image_lightbox').on('click dblclick', 'img', onLightboxImageClick);
}
