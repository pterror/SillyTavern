import { DOMPurify, css } from '../../lib.js';

/**
 * @typedef {import('@pterror/interact-markdown/look').HtmlElement} HtmlElement
 * @typedef {import('@pterror/interact-markdown/look').Html} Html
 */

/**
 * @typedef {object} PolicyOptions
 * @property {() => boolean} mediaAllowed whether media from other sites is loaded
 * @property {() => boolean} autoplay whether media may play by itself
 * @property {string} styleScope the selector a style element's rules are limited to, '' for none
 * @property {() => void} [blocked] hears that media from another site was hidden
 */

const ELEMENTS = new Set([
    'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'big', 'blink',
    'blockquote', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist',
    'dd', 'del', 'details', 'dfn', 'dir', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'font', 'footer',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend',
    'li', 'main', 'map', 'mark', 'marquee', 'menu', 'meter', 'nav', 'nobr', 'ol', 'optgroup', 'option', 'output', 'p',
    'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'select', 'small', 'source', 'span',
    'strike', 'strong', 'style', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead',
    'time', 'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
    'svg', 'animate', 'animatecolor', 'animatemotion', 'animatetransform', 'circle', 'clippath', 'defs', 'desc',
    'ellipse', 'feblend', 'fecolormatrix', 'fecomponenttransfer', 'fecomposite', 'feconvolvematrix',
    'fediffuselighting', 'fedisplacementmap', 'fedistantlight', 'fedropshadow', 'feflood', 'fefunca', 'fefuncb',
    'fefuncg', 'fefuncr', 'fegaussianblur', 'feimage', 'femerge', 'femergenode', 'femorphology', 'feoffset',
    'fepointlight', 'fespecularlighting', 'fespotlight', 'fetile', 'feturbulence', 'filter', 'g', 'image', 'line',
    'lineargradient', 'marker', 'mask', 'metadata', 'mpath', 'path', 'pattern', 'polygon', 'polyline',
    'radialgradient', 'rect', 'set', 'stop', 'switch', 'symbol', 'text', 'textpath', 'title', 'tspan', 'view',
]);

const MEDIA = new Set(['audio', 'video', 'source', 'track', 'img', 'picture', 'input', 'image', 'feimage']);
const MEDIA_URLS = ['src', 'srcset', 'poster', 'href', 'xlink:href'];
const OPENS_PAGES = new Set(['a', 'area']);
const KEPT_CLASS = /^(?:fa-|note-)|^monospace$/;

/**
 * @param {string} url
 * @returns {boolean} whether it points to another site
 */
function isExternal(url) {
    const at = url.trim();
    return (at.indexOf('://') > 0 || at.startsWith('//')) && !at.startsWith(globalThis.location?.origin ?? '\0');
}

/**
 * @param {string} name
 * @param {string} value
 * @returns {boolean} whether a media attribute loads from another site
 */
function loadsExternal(name, value) {
    if (name === 'srcset') return value.split(',').some(candidate => isExternal(candidate.trim().split(/\s+/)[0] ?? ''));
    return isExternal(value);
}

/**
 * @param {string} value
 * @returns {string} the classes, each prefixed so the text's styles can't reach the page's
 */
function prefixedClasses(value) {
    return value.split(/\s+/).filter(Boolean).map(name => (KEPT_CLASS.test(name) || name.startsWith('custom-') ? name : `custom-${name}`)).join(' ');
}

/**
 * @param {string} selector
 * @returns {string} the selector with each class prefixed as element classes are
 */
function prefixedSelector(selector) {
    return selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (match, name) => (name.startsWith('custom-') ? match : `.custom-${name}`));
}

/**
 * @param {string} text
 * @param {PolicyOptions} options
 * @returns {string | undefined} the style sheet limited to the scope, without imports, and without addresses on other
 *   sites unless their media is allowed; none when it doesn't parse
 */
function scopedStyle(text, { mediaAllowed, styleScope }) {
    const allowMedia = mediaAllowed();
    /** @param {any} rule */
    const scope = (rule) => {
        if (Array.isArray(rule.selectors)) {
            rule.selectors = rule.selectors.map((/** @type {string} */ selector) => `${styleScope}${prefixedSelector(selector)}`);
        }
        if (!allowMedia && Array.isArray(rule.declarations)) {
            rule.declarations = rule.declarations.filter((/** @type {any} */ declaration) => !String(declaration.value ?? '').includes('://'));
        }
        if (Array.isArray(rule.rules)) {
            rule.rules = rule.rules.filter((/** @type {any} */ inner) => inner.type !== 'import');
            rule.rules.forEach(scope);
        }
    };
    try {
        const sheet = css.parse(text);
        scope(sheet.stylesheet);
        return css.stringify(sheet);
    } catch {
        return undefined;
    }
}

/**
 * What HTML in chat text may draw: the elements and attributes DOMPurify allows, classes prefixed, style elements
 * limited to the text, media from other sites hidden unless allowed, autoplay unless allowed, links opening a new tab.
 * Anything else is drawn as its source.
 * @param {PolicyOptions} options
 * @returns {Html}
 */
export function chatHtmlPolicy(options) {
    return (name, attributes, content) => {
        if (!ELEMENTS.has(name)) return undefined;
        if (name === 'style') {
            const style = scopedStyle(content ?? '', options);
            return style === undefined ? undefined : { name, attributes: {}, content: style };
        }
        const allowMedia = options.mediaAllowed();
        /** @type {Record<string, string>} */
        const kept = {};
        for (const [attribute, value] of Object.entries(attributes)) {
            if (attribute === 'markdown' || (attribute === 'autoplay' && !options.autoplay())) continue;
            if (!DOMPurify.isValidAttribute(name, attribute, value)) continue;
            if (MEDIA.has(name) && MEDIA_URLS.includes(attribute) && !allowMedia && loadsExternal(attribute, value)) {
                options.blocked?.();
                return { name, attributes: { hidden: '' } };
            }
            kept[attribute] = attribute === 'class' ? prefixedClasses(value) : value;
        }
        if (OPENS_PAGES.has(name)) {
            kept.target = '_blank';
            kept.rel = 'noopener';
        }
        return { name, attributes: kept, ...(content === undefined ? {} : { content }) };
    };
}
