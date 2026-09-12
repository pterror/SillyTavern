import { morphdom } from '../../lib.js';

export function isSegmenterSupported() {
    return typeof Intl.Segmenter === 'function';
}

/**
 * @param {HTMLElement} htmlElement
 * @param {string} htmlContent
 * @param {'word'|'grapheme'|'sentence'} [granularity='word']
 */
export function segmentTextInElement(htmlElement, htmlContent, granularity = 'word') {
    htmlElement.innerHTML = htmlContent;

    if (!isSegmenterSupported()) {
        return;
    }

    // TODO: Support more locales, make granularity configurable.
    const segmenter = new Intl.Segmenter('en-US', { granularity });
    const textNodes = [];
    const walker = document.createTreeWalker(htmlElement, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
        const textNode = /** @type {Text} */ (walker.currentNode);

        if (textNode.parentElement && textNode.parentElement.closest('pre, code')) {
            continue;
        }

        if (/^\s*$/.test(textNode.data)) {
            continue;
        }

        textNodes.push(textNode);
    }

    for (const textNode of textNodes) {
        const fragment = document.createDocumentFragment();
        const segments = segmenter.segment(textNode.data);
        for (const segment of segments) {
            // TODO: Apply a different class for different segment length/content?
            const span = document.createElement('span');
            span.innerText = segment.segment;
            span.className = 'text_segment';
            fragment.appendChild(span);
        }
        textNode.replaceWith(fragment);
    }
}

/**
 * @param {HTMLElement} messageTextElement
 * @param {string} htmlContent
 */
export function applyStreamFadeIn(messageTextElement, htmlContent) {
    const targetElement = /** @type {HTMLElement} */ (messageTextElement.cloneNode());
    segmentTextInElement(targetElement, htmlContent);
    morphdom(messageTextElement, targetElement);
}
