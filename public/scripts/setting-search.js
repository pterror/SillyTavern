/**
 * Search for settings that match the search string and highlight them.
 */
async function searchSettings() {
    removeHighlighting();
    const searchString = String($('#settingsSearch').val());
    const searchableText = $('#user-settings-block-content');
    if (searchString.trim() !== '') {
        highlightMatchingElements(searchableText[0], searchString);
    }
}

/**
 * Check if the element is a child of a header element
 * @param {HTMLElement | Text | Document | Comment} element Settings block HTML element
 * @returns {boolean} True if the element is a child of a header element, false otherwise
 */
function isParentHeader(element) {
    return $(element).closest('h4, h3').length > 0;
}

/**
 * Recursively highlight elements that match the search string
 * @param {HTMLElement | Text | Document | Comment} element Settings block HTML element
 * @param {string} searchString Search string
 */
function highlightMatchingElements(element, searchString) {
    $(element).contents().each(function () {
        const isTextNode = this.nodeType === Node.TEXT_NODE;
        const isElementNode = this.nodeType === Node.ELEMENT_NODE;

        if (isTextNode && this.nodeValue.trim() !== '' && !isParentHeader(this)) {
            const parentElement = $(this).parent();
            const elementText = this.nodeValue;

            if (elementText.toLowerCase().includes(searchString.toLowerCase())) {
                parentElement.addClass('highlighted');
            }
        } else if (isElementNode && !$(this).is('h4')) {
            highlightMatchingElements(this, searchString);
        }
    });
}

/**
 * Remove highlighting from previously highlighted elements.
 */
function removeHighlighting() {
    $('.highlighted').removeClass('highlighted');
}

export function initSettingsSearch() {
    $('#settingsSearch').on('input change', searchSettings);
}
