# UI style

The one model every area's rewrite is held to (design-agenda H, C, J, D; decision D1). It is taken from the user's own
projects, read 10-29: `~/git/lee-app` (`docs/redesign.md` "Patterns used everywhere", `src/web/styles.css`,
`src/web/ui/`), `~/git/cyoa` (`DESIGN.md`, `src/client/style.css`), and pteraworld's games
(`src/games/core/`, `src/games/packs/shell/`, `public/games/games.css`). Each rule names where it comes from.

## What the screen is

- **The chat is the page.** Everything else is chrome around it and stays quieter than it. cyoa: "The only chrome:
  who's here, and one way into everything else"; "The surface: the page's text, readable and writable at once".
- **One home per thing** (lee-app). A character, a lorebook, a preset each have one place where they're shown and
  edited; every mention of one is a link to it.
- **Edit in place** (lee-app). A field is edited where it's shown and kept on Enter or on leaving it. No read-only view
  with an Edit button that opens a dialog. Text is "readable and writable at once" (cyoa).

## Kinds of surface, and when each is used

| Kind | Used for | Never for | From |
|---|---|---|---|
| side panel | a record (character, group, lorebook, a settings place) opened in the left or right slot beside the chat, which stays in view (over the chat from its edge in a narrow window). A slot is a stack: a panel opened in an occupied slot goes in front; Back or Escape returns to the one under it, scroll and state kept | a quick choice | lee-app "Side panels for records" |
| dialog (centred; a bottom sheet on a phone) | a focused task with an end: choose an alternative, import, create, a confirmation that states exactly what will happen | browsing or editing a record | lee-app "dialogs only for focused tasks", `ui/panel.tsx` |
| menu | the commands on a thing: context menu, marking menu (touch), palette | settings, content | pteraworld `surfaces.ts` |
| popover | a glimpse (a link's target, a mention's card, a tooltip) and autocomplete | anything that needs input beyond a pick | cyoa "A glimpse", pteraworld `tooltips.ts` |
| inline | an error, a state, "Saved", a disabled control's reason: beside what it's about | — | lee-app `ui/inline.tsx` |
| toast | only what happened out of sight, with Undo or Retry when there is one; at most three, bottom centre | a result the user can see | lee-app `ui/toast.tsx`, cyoa `.toast`, agenda D |

So the old "modals suck" / "bring the modal back" (R 10-02) is not one answer: the swipe picker and greetings list are
a dialog (a choice with an end); character info is a side panel (a record).

Every surface opens through the page shell: it gets its layer, its clip of what's under it, focus (returned where it
was on close, lee-app `Panel`), and Escape (the innermost thing closes first; an edit in progress is innermost). There
is no other way to put something on top (DR11). Whether a surface in front hides what's behind it or lets it show through
is the theme's choice (it matters only for translucent panels), applied to every surface alike.

## Actions

- **Every action is a command** (pteraworld `core/commands.ts`: ids, labels, descriptions, keys and mouse bindings as
  data, "everything the player can do is a command"). Buttons, menu items, slash commands and bindings are drawn from
  it.
- **One set of commands, one look everywhere** (pteraworld `surfaces.ts`: "Every board-menu entry point… renders
  through one of these, so a command appears the same everywhere"): list, radial, tiles.
- **One primary action per item; the rest in its menu** (lee-app). A row shows the one thing it's most likely there
  for.
- **A command menu that finds and does** (lee-app ⌘K: "finds any family… and also *does* things"). Here: Ctrl+K and
  `/`.
- **Undo where it can be undone; a confirmation only where it can't**, and it says exactly what will happen, with
  numbers (lee-app: "Sends to 42 families, $28,410"). Deleting a message is undone, not confirmed.
- **No dead ends** (lee-app). A "can't" carries its fix: a field, an alternative, or who can do it. A control the user
  can't use right now is disabled, its reason on hover and focus (agenda D rule 3); one they can never use isn't shown.
- **Optimistic is not allowed for stored data here**: the server stores first, then the page shows (agenda B). What
  lee-app gets from "optimistic and live" this app gets from the cached view shown first and pushes (`views.md`).

## Touch

- Tap targets are at least 44 px on a coarse pointer (lee-app `--tap: 44px`, cyoa `min-width: 44px; height: 44px`).
- The tools a touch user needs sit along the bottom under the thumb, above the on-screen keyboard (cyoa "Touch
  screens: the toolbar along the bottom under your thumb").
- Without a keyboard, key hints aren't shown (cyoa `data-keyboard="no"`).
- On a message: the marking menu (decision D2). Touch and flick; the direction picks the command; the menu draws only
  when the finger pauses. Left / right: previous / next alternative. Up: bookmark. Down: edit. Diagonals: the next
  most used commands, from the registry. A linear menu where a radial one doesn't fit. pteraworld's board menu opens on
  a 550 ms hold (`core/gestures.ts` `HOLD_MS`); that delay is what the user rejected for messages ("long press is
  garbage ux BC it's incredibly slow", 10-29), so nothing here waits before acting.
- An edge swipe opens the left or right panel.
- No modifier variants (Shift-, Alt-, double-click): a second action is a second command, in the menu and palette.

## Text

- The reading face is a serif at a reading size and measure (cyoa `--read`, `--size: 19px`, `--measure: 680px`); the
  UI face is the system's (cyoa `--ui`, lee-app `--font`). The chat's font stays the theme's (compat).
- **Markup while writing is still there, just quieter than the words** (cyoa `.cm-syntax { opacity: 0.45 }`; decision
  D4, Discord's way). Never hidden. HTML comments and images always visible. A note for writers (an HTML comment) is
  marked as such (cyoa).
- Numbers are tabular (lee-app `font-variant-numeric: tabular-nums`).
- Words: the user's words, true statements, consequences in numbers (lee-app "Words"). Wording pass after this model
  (agenda P).

## Tokens and themes

- **Every colour and font is a variable**, so a theme or custom CSS changes all of it (cyoa's first line; pteraworld
  "views and mods should style with these so themes apply everywhere").
- The set: `--bg`, `--surface`, `--surface-2`, `--sunk`, `--text`, `--muted`, `--line`, `--line-strong`, `--accent`,
  `--accent-soft`, `--danger`, `--danger-soft`, `--warn`, `--ok`, `--focus`, `--match` (search highlights, ALT),
  `--shadow`, `--shadow-strong`, `--radius` (12 px), `--radius-sm` (8 px), `--tap` (40 px, 44 px coarse), `--gutter`
  (28 px, 16 px under 760 px), `--ease` (lee-app's tokens, named alike in all three projects).
- Light and dark both, by `prefers-color-scheme` unless the user picks one (all three).
- **Compat**: upstream themes set `--SmartTheme*` variables; the defaults of these tokens are taken from them
  (`--text: var(--SmartThemeBodyColor)` and so on), so every existing theme still applies.
- A user can override single tokens, each with a plain label (pteraworld `COLOR_TOKENS`: "background", "panels",
  "quiet text"…). A choice's preview is its default view (Q6).

## Motion

- Things that appear rise in (≈160 ms, a slight overshoot) and sink out faster (≈120 ms) (cyoa "Things that appear
  and go"). A pressed button scales to 0.94 (cyoa). Hover states only where there's a pointer to hover with (cyoa
  `@media (hover: hover)`).
- `prefers-reduced-motion` turns it off; no app setting for it (UV).

## Layout

- Space is reserved for whatever can appear in place, so nothing moves what's around it (pteraworld `.w-status`:
  "reserves two lines, so a message appearing or wrapping never moves what sits above or beside it"; R 10-25 on layout
  shift).
- Layout is decided by the window's width, never by a device mode (UV on Force Mobile View).
- Placement of panels and widgets is data the user can change (pteraworld `layout.ts` slots: above, beside, below, a
  sidebar tab, over, hidden), replacing movingUI (DR22).

## Settings

- **Asked when first needed**, at the point of need, and kept in the settings place for later changes (lee-app item
  23: "Settings are asked when they're first needed"). Audio's default volume and autoplay (AU1) are the first case.
- One tooltip system, from the command or setting data (label, what it does, its keys); native `title` tooltips are
  not used beside it (pteraworld `tooltips.ts`).

## Kept honest by

- The page shell is the only way to open a surface (a lint rule bans `document.body.append` / `appendChild` of
  surfaces and `position: fixed` outside the shell's stylesheet in `packages/`).
- Colours in `packages/` come from the tokens (a lint rule bans colour literals in area stylesheets).
- A browser test per area opens each of its surfaces at phone and desktop widths and checks: no element under 44 px
  that takes a tap on a coarse pointer, no layout shift on open, Escape closes the innermost thing.
