import { cardsPerTopLevelEntry, MAX_CARDS_PER_READ, readFitsTheBudget } from '../protocol.ts';
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
// Rough heights for reading enough top-level entries for a screen before any is measured.
export const CARD_HEIGHT = 92;
export const PLAIN_ROWS_PER_SCREEN = 8;

export type PageLayout = { overview: OverviewLayout; columns: number; topLevelPerRead: number };

export const columnsIn = (width: number): number => Math.max(1, Math.floor((width + GAP) / (CARD_MIN_WIDTH + GAP)));

export function pageLayout(paneWidth: number): PageLayout {
    const width = Math.max(CARD_MIN_WIDTH, paneWidth - 2 * PAGE_INSET);
    const levels: RegionLayout[] = Array.from({ length: NESTING_LEVELS }, (_, level) => {
        const columns = columnsIn(width - 2 * REGION_INSET * (level + 1));
        return { columns, rows: Math.max(ROWS_PER_REGION, Math.ceil(CELLS_PER_REGION_AT_LEAST / columns)) };
    });
    const overview: OverviewLayout = { regionsByNestingLevel: levels, cardTextCharacters: CARD_TEXT_CHARACTERS };
    const topLevelPerRead = Math.max(1, Math.floor(MAX_CARDS_PER_READ / cardsPerTopLevelEntry(levels)));
    return { overview, columns: columnsIn(width), topLevelPerRead };
}

// How many top-level entries one read asks for: a few screens of plain cards, as many as the budget allows.
export function topLevelShown(layout: PageLayout): number {
    const wanted = 3 * PLAIN_ROWS_PER_SCREEN * layout.columns;
    let shown = Math.min(wanted, layout.topLevelPerRead);
    while (shown > 1 && !readFitsTheBudget(shown, layout.overview)) shown--;
    return shown;
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
