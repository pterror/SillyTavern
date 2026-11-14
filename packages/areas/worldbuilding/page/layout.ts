import type { OverviewLayout, RegionLayout } from '../protocol.ts';

// public/css/mobile-styles.css's breakpoint, where the page is laid out for a phone.
export const PHONE = 'screen and (max-width: 1000px)';

// Kept equal to public/css/worldbuilding.css.
const PAGE_INSET = 40;
const REGION_INSET = 17;
const CARD_MIN_WIDTH = 320;
const GAP = 14;
const ROWS_PER_REGION = 2;
// A region in a narrow column still shows a few of its members before its "+N more".
const CELLS_PER_REGION_AT_LEAST = 4;
// Region members are drawn at the top level and inside a region nested in it; deeper regions are drawn as their cards.
const NESTING_LEVELS = 2;
// A region head's text runs two lines of at most 80 characters; more is read so the clamp, not the cut, ends it.
const CARD_TEXT_CHARACTERS = 240;
export const PLAIN_ROWS_PER_SCREEN = 8;
// How many screens of top-level entries are read ahead of what is on screen.
export const SCREENS_AHEAD = 10;
// Kept equal to the cards' contain-intrinsic-size in public/css/worldbuilding.css: a card's height before it is drawn.
export const CARD_HEIGHT_BEFORE_DRAWN = 92;

// How many top-level entries fill SCREENS_AHEAD screens of a pane `height` tall before any is drawn.
export const aheadIn = (height: number, columns: number): number =>
    columns * Math.max(1, Math.ceil((SCREENS_AHEAD * height) / CARD_HEIGHT_BEFORE_DRAWN));

export type PageLayout = { overview: OverviewLayout; columns: number };

export const columnsIn = (width: number): number => Math.max(1, Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP)));

export function pageLayout(paneWidth: number): PageLayout {
    const width = Math.max(CARD_MIN_WIDTH, paneWidth - 2 * PAGE_INSET);
    const levels: RegionLayout[] = Array.from({ length: NESTING_LEVELS }, (_, level) => {
        const columns = columnsIn(width - 2 * REGION_INSET * (level + 1));
        return { columns, rows: Math.max(ROWS_PER_REGION, Math.ceil(CELLS_PER_REGION_AT_LEAST / columns)) };
    });
    const overview: OverviewLayout = { regionsByNestingLevel: levels, cardTextCharacters: CARD_TEXT_CHARACTERS };
    return { overview, columns: columnsIn(width) };
}

export function sameLayout(one: OverviewLayout, other: OverviewLayout): boolean {
    return (
        one.cardTextCharacters === other.cardTextCharacters &&
        one.regionsByNestingLevel.length === other.regionsByNestingLevel.length &&
        one.regionsByNestingLevel.every(
            (level, at) =>
                level.columns === other.regionsByNestingLevel[at]?.columns &&
                level.rows === other.regionsByNestingLevel[at].rows,
        )
    );
}
