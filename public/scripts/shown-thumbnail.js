import { newUi } from './new-ui-page.js';

/**
 * @param {string | null | undefined} thumbnail
 * @param {string | null | undefined} still
 * @returns {string | null | undefined}
 */
export function shownThumbnail(thumbnail, still) {
    if (!still) return thumbnail;
    let animated = true;
    try {
        animated = newUi().backgrounds.background_settings.animatedThumbnails !== false;
    } catch {
        animated = true;
    }
    return animated ? thumbnail : still;
}

/**
 * @param {HTMLImageElement} img
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} crop
 */
export function frameImage(img, crop) {
    const container = img.parentElement;
    if (!container) return;
    if (!crop || !(crop.width > 0) || !(crop.height > 0)) {
        container.classList.remove('framed_image');
        container.style.removeProperty('aspect-ratio');
        img.style.removeProperty('width');
        img.style.removeProperty('left');
        img.style.removeProperty('top');
        return;
    }
    container.classList.add('framed_image');
    container.style.aspectRatio = `${crop.width} / ${crop.height}`;
    const place = () => {
        if (!img.naturalWidth) return;
        img.style.width = `${(img.naturalWidth / crop.width) * 100}%`;
        img.style.left = `${-(crop.x / crop.width) * 100}%`;
        img.style.top = `${-(crop.y / crop.height) * 100}%`;
    };
    if (img.complete && img.naturalWidth) place();
    else img.addEventListener('load', place, { once: true });
}
