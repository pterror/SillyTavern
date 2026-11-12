/**
 * @typedef {import('@pterror/interact-editor/reader').Overlay} Overlay
 * @typedef {import('@pterror/interact-editor/reader').Range} Range
 */

const DURATION = 300;

/**
 * Text added to a streamed reply fading in: each addition is a range that animates for its duration. A redrawn range
 * starts its animation where the time since its addition has it, so redrawing a block doesn't fade its text again.
 * @returns {Overlay & { added: (from: number, to: number) => void }}
 */
export function fadeIn() {
    /** @type {{ from: number, to: number, at: number }[]} */
    let additions = [];
    return {
        added(from, to) {
            const now = performance.now();
            additions = additions.filter(each => now - each.at < DURATION && each.to <= from);
            if (to > from) additions.push({ from, to, at: now });
        },
        ranges() {
            const now = performance.now();
            additions = additions.filter(each => now - each.at < DURATION);
            return additions.map(each => ({
                from: each.from,
                to: each.to,
                class: 'text-fade-in',
                attributes: { style: `animation-delay: -${Math.round(now - each.at)}ms` },
            }));
        },
        watch: () => () => undefined,
    };
}
