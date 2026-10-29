# Design agenda: every UX symptom on record, grouped by the design problem behind it

For the sit-down asked for on 10-29 (P:553): settle the right model for each problem before building anything, then
rewrite each area from that model. Nothing here is a fix. A symptom marked "fixed" was patched locally, and the design
problem behind it is still open.

**Status (10-29):** agreed as a whole. The user accepted every model and recommendation below, and the four decisions
as proposed (§5): "idc, you should try ur best, itd take me too much time to review individually". §3 is the build
order.

## Source keys
- **P:n**: `/home/me/.claude/plans/majestic-spinning-swan.md`, line n. Inventory ids (CH1, ED7, ...) are rows in its tables.
- **U12 / U16**: the user's lists of 2026-10-12 and 2026-10-16 (`.plans/2026-10-03-backlog.md` in
  `~/sillytavern-harness-backup-2026-10-17.tgz`). **U23**: P:347-369. **U25**: P:373-385. **U27**: P:519-524. **U29**: P:532-542, P:571-576.
- **R date**: the user's verbatim words (`scratchpad/user-rules-verbatim.md`, or the repo `CLAUDE.md`).
- **BL §n**: the backlog's own section n (same tarball).
- **Inv-US / Inv-CB / Inv-CM / Inv-MB / Inv-T / Inv-I**: `scratchpad/inventory-{user-settings,char-bar,char-more,mes-bar,toasts,importers}.md`, with a row or bug number.
- **SR / UV / PM / MOD / ALT / CN / INS / SS**: `docs/design/` `settings-reorganization.md`, `user-settings-verdicts.md`,
  `prompt-model.md`, `modules.md`, `alternatives.md`, `chat-names.md`, `install-and-update.md`, `settings-scopes.md`.
- **Audit**: `.plans/2026-10-03-thin-client-audit.md` (same tarball). **upstream**: the checkout at `scratchpad/upstream` (ad29cbda6), checked by grep.

## 1. The problems, ordered by how many symptoms trace to each

| # | Design problem | Symptoms | Already settled by an agreed doc? |
|---|---|---:|---|
| A | Each action has many affordances: no single place defines an action | 19 | partly (MOD command point, UV); the registry itself has no doc |
| B | The page owns shared, mutable state instead of rendering server views | 18 | partly (ALT for one surface) |
| C | Surfaces have no single model for layering, clipping and layout | 18 | no |
| D | No rule for when and where to tell the user something | 17 | no (the rule exists only in Inv-T's header) |
| E | Mechanisms, modes and duplicate concepts are presented as settings | 16 | yes (SR, UV, PM) |
| F | Settings have no places: one idea lives in several, grouped by code | 16 | yes (SR, UV, PM, SS) |
| G | The page fetches and computes on its own schedule, and nothing cached is shown first | 15 | partly (ALT for one surface) |
| H | No shared visual and interaction vocabulary (UI1) | 15 | no |
| I | The conversation tree has no settled UI model (chats, bookmarks, branches, alternatives) | 14 | partly (ALT, CN) |
| J | Hidden gestures and modifiers; behaviour differs by device | 12 | no (direction settled 10-29, P:565) |
| K | Search and filters have no single model | 11 | no (Q11 plan entry only) |
| L | The page treats its DOM and events as data | 11 | no |
| M | One text has several renderings (two markdown parsers, separate field pipelines) | 11 | settled 10-26 (P:425), not in docs/design |
| N | Steps called done that weren't; rules not enforced | 10 | n/a (process) |
| O | Import has no single model | 9 | yes (MOD) |
| P | Names aren't clear to a layperson | 9 | partly (CN) |
| Q | Old code carried over | 8 | n/a (how to port) |

The candidate problems in the brief map onto these as follows:
- "Too many concepts / toggles" is split into E (things that shouldn't be settings) and F (settings without a home).
- "Hidden gestures" is J. The user ties it to A ("Part of the overwhelm problem", P:563), and both share one model (the command registry).
- C, H, I, K, M, O and P were not in the brief. The sources support each of them.

Unplaced symptoms and feature requests are in §4.

---

## 2. Each problem

### A. Each action has many affordances: no single place defines an action (19)
Symptoms:
- "do you understand that there are a lot of fucking affordances right now? way too many?". Listed: buttons, '…' expanders, menus, hover bars, long presses, shift/alt/double-clicks, shortcuts, slash commands. (R 10-29; P:563)
- Editing a message has five entry points: Edit button, click-to-edit setting, Up arrow, Ctrl+Up, and overswipe on user messages and greetings. (Inv-MB #15)
- Changing a swipe has six: arrows, ArrowLeft/Right (last message only), touch swipe, `/swipe`, the picker, the counter. (Inv-MB c1-c4, #12)
- "Jump to swipe history" and the swipe counter open the same picker. (Inv-MB #12/c3)
- Bookmarking has three: the message button, Options "Save bookmark" (last message only), `/checkpoint-create`. (Inv-MB #14)
- Deleting has five: the edit bar, Options "Delete messages" mode, `/del`, `/cut`, `/delswipe`. (Inv-MB b5)
- Message actions sit behind a "…" expander, and a setting makes it always expanded. (Inv-MB #1; Inv-US 4067)
- Favouriting has four: the bar star, the bulk context menu, bulk favourite, `/char-update favorite=`. (Inv-CB 2)
- Linking a lorebook: the globe button (4 behaviours), More… "Link to World Info" and "Import Card Lore", `/char-update world=`. (Inv-CB 6; Inv-CM 1-2)
- Duplicate and Delete character each sit on the bar, in the bulk menu and in a slash command. (Inv-CB 11, 13)
- The "More..." `<select>` holds 10 actions beside a button row. "garbage ux and needs a redesign / same with all the garbage button rows". (Inv-CM; DR16, BL §3 user 09-16)
- Rename sits in the dropdown instead of a pen icon, double-click and inline input. (U16, CL10; Inv-CB notes an inline rename now exists, script.js:14035, not re-checked)
- The input bar has a Quick "Continue" button, a Quick "Impersonate" button, and "Send" to Continue, which overloads an empty Send. (Inv-US 4367-4379; UV "The input")
- The gallery opens from a More… option, the wand button and `/show-gallery`. (Inv-CM 10)
- `/flat`, `/bubble`, `/single`, `/vn`, `/theme` and `/css-var` write the same settings the controls do. (Inv-US flags c)
- The group panel repeats Chat Lore, media overrides and scenario. (Inv-CB 7, 9; Inv-CM 4)
- Quick replies were moved one by one: "really what i probably need rather/too is toggles for qr visibility". (U16, EX3)
- The hotkey dialog has no rebinding, no descriptions and no palette (DR25, user 10-24), and the list isn't checked against the real handlers (DR18).
- Settings Search covers only the User Settings drawer. (Inv-US header)

How it got in: upstream has the More... select and the "…" expander. Grep of upstream: `char-management-dropdown` in 5 files, `extraMesButtonsHint` in 4. The fork added the Ctrl hotkey overlay (26bb3ca7b). MOD lists menu items, buttons, quick replies and slash commands as today's separate forms of one thing (MOD:28). Why each control was added: unknown.

Model: one **command registry** (Q7, P:497):
- Every action is a command: an id, what it acts on, and when it's available (with the reason when it isn't).
- Buttons, menu items, slash commands, quick replies, the palette, context menus and bindings are all generated from it.
- One visible control per action per device. The palette and context menu are the complete list. The duplicate on-screen controls go.
- Bindings (keys, gestures) are data, rebindable and stored on the server. Settings search is a set of palette entries.

Replaces: the More… select, the "…" expander and Expand Message Actions, Quick Continue/Impersonate, the hotkey overlay, quick-reply sets as a separate system (decided 10-27, P:506), and every per-feature duplicate.

Agreed doc: MOD (command extension point) and UV (commands, pins) cover parts of this. The registry has no design doc. Recommendation: write one before Q7.

### B. The page owns shared, mutable state instead of rendering server views (18)
Symptoms:
- In create mode, the palette button writes the previously opened character's `allow_global_styles`, and More… "Replace / Update" would overwrite that character's card. (Inv-CB bug 1; Inv-CM bug 2; the palette part was hidden in fc0533d8b, P:550)
- In create mode with no character, "Replace / Update" and "Import Tags" throw, and the select stays stuck on that option. (Inv-CM bug 3)
- "Link to Source" keeps the last character's disabled state in create mode. (Inv-CM bug 4)
- Aux books are dropped in create mode with no chat open. (Inv-CM bug 1; fixed a9724573e, P:503)
- The media-override icons stay stale after a change. (Inv-CB bug 2)
- An embedded file shows nothing until a re-render, because a stale `chat[]` object is passed on. (Inv-MB bug 2)
- One swipe can lock all swiping until reload: `swipeState` is never reset. (Inv-MB bug 1; fixed 479fd51cd)
- "Show Gallery" in a group-member peek opens the group's gallery. (Inv-CM bug 6)
- The Chat Lore button with no chat open writes `chat_metadata`. (Inv-CB bug 4, inferred)
- One global chat array is emptied and refilled on every switch, so a handler that awaits writes into whichever chat is open by then. (P:560)
- A session on another device sits on an earlier message without seeing the branch onward: "must not break either client". (U29, P:538)
- Overswipe, then swipe back: the continuation stays shown, then the message reads 1/1 and the first swipe is gone. (U23; P:11-15; CH1 fixed 13405045b)
- Editing a card greeting sometimes duplicates it in the chat. (CH31, user 10-25)
- An in-chat greeting edited to equal a card greeting isn't deduplicated (U23, CH2 fixed 6057c5ed7). The opening alternatives are joined on the page (CH35).
- Greetings in character info jump back to the first after an edit. (U12, CL6 fixed)
- A blank new greeting removed with X doesn't leave the list. Saving a non-sole greeting as blank does "the wrong thing (?)". (U27 GR1, GR3)
- Creating a character loses its tags and can't take a first greeting. (U23, CL2/CL3 fixed 6057c5ed7)
- "data loss on page reload in general = not ideal". (R 09-29)

How it got in:
- The audit's root cause: "The page still runs upstream's flows… each step kept the page's flow and only changed what a step calls."
- "Create new" doesn't clear `this_avatar` (Inv-CM header).

Model:
- "client sends user actions only / server sends state updates" (CLAUDE.md).
- Every surface is opened on an explicit target (entity id plus version), never on "the current character".
- `getContext()` is bound to the chat open when it's called, and each chat has its own array (P:560).
- Views carry versions and the newest wins (ALT "Rules checked").
- A stored chat stores first and then shows, with an error if the store refuses. A temporary chat stays on the page only. (P:549; ALT "Adding an alternative")
- Each version of a greeting's text has its own identity and lineage (P:569).

Agreed doc: ALT covers this for the alternatives surface only. P:549, P:560 and P:569 are plan entries. Recommendation: move them into docs/design as the general rule.

### C. Surfaces have no single model for layering, clipping and layout (18)
Symptoms:
- Drawer occlusion over `#sheld` is broken (U23, DR1). The clipping rule for management isn't done (U12, DR5). Clipping is wrong in single-column mode (U12, DR7). Occlusion is broken in general, e.g. Advanced Formatting (U12, DR10). (Fixed per drawer: 9353e9a59 and others)
- The chat is immune to clipping by the keybinds dialog. (U12, DR6; fixed 56781521f)
- Overlays skip occlusion: filter-pill dropdowns, macro autocomplete, paste mode, prompt itemization, text preview, talkativeness, search views. "it should be architecturally impossible for any overlay/dialogue to forget to participate". (U12, U16; DR11)
- Split-hiding works from the chat drawer button but not when clicking a character in management. (U23, U16; DR2)
- The avatar preview appears behind management the first time. (U12, DR9)
- After editing a field in character info, opening management leaves character info on top. (U12, DR12)
- The connection profile overlaps management only with stacked drawers on. (DR13)
- The fullscreen loading popup isn't fullscreen. (DR15, BL §3)
- The typing indicator extension doesn't clip the chat, which "suggests the architecture is wrong". (U29, P:540)
- "how the fuck is/was overlap even architecturally possible"; and a dialog clips the character info sidebar and AI response configuration, but not the chat. (R 10-25)
- The chat input's formatting bar overlaps the quick replies / guided generations bar. (U25, ED33; a regression from 2dd9ab32b, fixed 4d557b853)
- Layout shift:
  - The toolbar's space isn't reserved (ED7). "any other option causes layout shift which is bad" (R 10-25).
  - The expanded tag area "STILL reflows due to changing in height" (R 09-23).
  - The find-and-replace presets shift the layout (U12, ED18).
  - Live-editor paragraphs shift on focus (ED25, fixed 2dd9ab32b).
- A chat lands a few px from the bottom on load (CH33). A swipe jumps 700-900 px (CH34, fixed af74bce0d).
- Management loses its scroll position on reopen (U23, CL1 fixed). Next and previous page should scroll to the top or bottom (U16, CL14).
- "modals suck" and "bring the modal back, sidebar drawer is unacceptable". (R 10-02, both)
- "escape when editing should stop editing (warning dialog if necessary) instead of closing the entire drawer no?" (R 10-02)
- The user wants arbitrary layout over movingUI: "1:1 user's mental model: affordance". (U16, DR22)
- Stacked Drawers (fork, a2192622a) and Force Mobile View (fork, 413560a71) are layout modes. (UV)

How it got in: occlusion was added per surface, each drawer with its own test (DR5, DR7, DR10 rows; 56781521f for popups). ED33 came from moving the toolbar in 2dd9ab32b (P:380). Unknown beyond that.

Model: the page shell (MOD "core: the page shell") owns every surface:
- Drawers, dialogs, popovers, overlays and extension UI all open through it and get their layer, clip, focus and Escape handling from it. An overlay outside it can't exist (DR11's requirement).
- Escape closes the innermost thing, and editing is innermost.
- Space is reserved for anything that can appear.
- The layout is three panes: left panel | chat | right panel (user 10-29: "we already have three panes where is there space for more"). Each side is one slot, and a slot is a stack: opening a panel in an occupied slot (character info over character management) puts it in front; Back or Escape returns to the one under it, with its scroll and state kept (CL1). No mode, no Stacked Drawers setting. Narrow windows follow the window's width, not a device mode (UV on Force Mobile View).
- Clipping stays optional (user 10-29: "clipping should still be optional right?"), as the theme's choice: the panel in front hides the one behind, or a translucent theme lets it show through. The layer model applies it to every surface uniformly (drawers, dialogs, popovers, extension overlays, the chat).
- The shell keeps scroll and position per surface.
- Which surface kind serves which job is part of H (DECISION D1).

Agreed doc: none. Recommendation: write it with H's model.

### D. No rule for when and where to tell the user something (17)
Symptoms:
- 1,157 toast calls. By verdict: DROP 151, INLINE 351, DISABLE 107, DEBUG 30. (Inv-T summary)
- 368 duplicate messages, 43 flagged for wording, 157 built from server or exception text. (Inv-T flags)
- "maybe need to audit toasts in general". (R 10-27)
- "when copying something, notify the user maybe (?) idk if too annoying". (U12, DR21)
- The client didn't show generation errors (llama.cpp not running). (U16, GE4; fixed 1f88d2c2e)
- A send click dropped mid-swipe gave no feedback. (CH4, fixed 9211846e8)
- A failed append was only `console.error`'d. (CH24, fixed)
- Enter dropped on a cold page: nothing sent, no toast. (TT26, open)
- After Stop, neither the sent message nor the stored reply shows, and there's no toast. (TT34 / Q8)
- `/addswipe` on message 0 changes only the page: no request, silent, lost on reload. (U29 BUG, P:542, P:549)
- A failed export is silent. (Inv-CB bug 3)
- Overswipe-and-save "now it even shows toast warnings". (U23, CH1)
- "Greeting not saved — changed in another session" appears when the only greeting is blank. (U27 GR2)
- A switch is refused with only a toast (isChatSaving, is_send_press, field editing). (P:559)
- A failed send's retry and discard live in a sticky toast, not on the message. (Inv-T "other mechanisms"; Inv-MB c24)
- Server log spam:
  - search catch-up and metadata counting (U12, TS14 fixed);
  - stack traces when llama.cpp is down (U16, GE8 fixed);
  - "god why so much logspam" and "specifically, single updates shouldn't log" (R 10-02);
  - about 518 page and 291 server log calls (TT20).
- The Image Generation one-time notice is a popup. (Inv-T popup table)

How it got in: upstream has 1,000 `toastr.*(` calls in `public/` (grep, lib excluded; the scope differs slightly from Inv-T's 1,157). There is no notify helper: "No other wrapper function around toastr was found" (Inv-T). Most of the calls are inherited. Which ones the fork added hasn't been counted.

Model: the four rules in Inv-T's header, given as "the user's direction":
1. No toast for a result the user can see.
2. An error goes beside what owns it.
3. "Can't do this now" is a disabled control with the reason on hover.
4. A toast is only for what happens out of sight.

Plus:
- Stored data is stored first, then shown, and a refusal shows at the thing (P:549).
- The server logs nothing on success (R 10-02).

Recommendation: one notify module owns toastr, and a lint rule bans `toastr.` anywhere else (global CLAUDE.md: enforce rules with lint).

Replaces: 1,157 ad-hoc calls, the toast-with-buttons tricks, and the copy toasts (a copy button flips to a check, Inv-T pattern 15).

Agreed doc: none. Recommendation: write the rule into docs/design before ports apply Inv-T's verdicts.

### E. Mechanisms, modes and duplicate concepts are presented as settings (16)
Symptoms:
- About 570 controls across the four settings drawers. (SR table)
- Advanced Mode hides about 40 settings, among them Enter to Send and Swipes. (SR §6; Inv-US)
- Values the app should work out are shown as settings: context size, best-match tokenizer, the derive bolts, Bind Model to Templates, Bind to Context, bind preset to connection, bypass status check, Relaxed API URLs. (SR §4)
- Templates are picked automatically by five mechanisms. (SR §1; Q2)
- Mad Lab Mode and Zen Sliders. (Inv-US; UV)
- Four streaming knobs exist because the old redraw was slow. (UV)
- Redundant pairs: No Blur beside Blur Strength, No Shadows beside Shadow Width, Reduced Motion beside the OS setting. (UV)
- Dead or near-dead settings: Lorebook Import Dialog (no reader), Relaxed API URLs, STRICT_ESCAPING, Log prompts. (SR §6)
- "Keep recently used characters" plus a count: a cache size offered as a setting. (UV)
- "Faster quoted phrases" was a user option. (Removed 10-27, P:529)
- Lorebook entries have about 20 activation fields. Triggers and scan depth show on constant entries: "wtf?" (U16, WI4; P:476)
- "lorebook 'scan depth cannot exceed 1000' is dumb". (U16, WI3)
- "Author's notes are the wrong mental model". (BL §6, ST4)
- "i feel like 'tags to embed' is kinda bullshit". (U23, TS1)
- "Guided Generations existing implies missing core functionality / mental model". (U29, P:535)
- Confirmation on delete is a setting, not undo; Swipes can be turned off. (UV "The input")

How it got in:
- SR's analysis groups the drawers "by code history" (P:484).
- Advanced Mode was added by the fork in 8513f5f50 (2026-09-12). The same day the user wrote "yes fucking gate it but make its fucking visibility conditional on text completion AND advanced mode" (R 09-12). What "it" referred to isn't in the quote.

Model: SR's five places and UV's verdict per control: cut, one behaviour, derived, theme, at the thing, command, or elsewhere. Nothing sits behind a mode. PM: an entry has one condition, which replaces about 20 activation fields (WI4 is settled there). Notes are entries; a "default note" is inherited, not copied (ST4).

Agreed doc: **settled** by SR, UV and PM, except two items:
- TS1 (exported vs local tags) is in no doc.
- Guided Generations hasn't been read. Recommendation: read what it does first, then decide what core lacks.

### F. Settings have no places: one idea lives in several, grouped by code (16)
Symptoms:
- System prompt, after-history instructions and examples: 3 places each. (SR §1)
- Names in the prompt: 5 places. Stop strings: 6. Starting the reply and reasoning: several each. Streaming: 4 toggles. (SR §1)
- One backend is reachable through two API kinds, with separate keys and models. (SR §1)
- One parameter goes under several names (`temp_openai` / `temp` / `temperature`). (SR §1; P:472)
- The Formatting drawer is hidden for chat completion, though its cleanup, stop strings and reasoning apply there. (SR §2)
- Which panels show is decided by the API family, not by the backend the user picks. (SR §2)
- Generation settings sit among the display settings. "Show {{char}}:" trims the output. (SR §3; Inv-US flags a)
- The theme holds Lab Mode, Zen Sliders, Tags as Folders, Hotswap and Click to Edit. Several appearance settings aren't in it. (SR §5)
- The chat completion preset holds connection settings and prompts. The context template holds three global switches. (SR §5)
- "backgrounds belong in the theme, and should move to the cascade model". (U29, P:536)
- "Character Settings Overrides" are per chat, not per character, and saved on cancel. (Inv-CM 4, bug 5; save-on-cancel fixed P:550)
- Per-character media overrides are stored in the user's settings. (Inv-CB 9)
- Relaxed API URLs sits in User Settings, and only KoboldAI Classic reads it. (Inv-US)
- Image Swipe Behavior is an extension's setting placed in User Settings. (Inv-US)
- "four settings drawers… hundreds of settings and no consistent rule for what goes where". (user 10-27, P:472)
- "where settings live is unclear (a setting's level, a preset's field, a connection)". (UI1, P:464)

How it got in: "Which sampler panel and which prompt system you see is decided by the first choice in API Connections… which is how the code is split" (SR §2).

Model:
- Five places: Connection, Generation, Prompt, Appearance, Behaviour.
- Presets follow the places. A profile names a connection and two presets.
- Levels cascade (SS; ST1 steps P:428-459).
- Settings search is the palette over all five places.

Agreed doc: **settled** by SR, UV, PM and SS. Backgrounds-in-theme (U29) needs a line added to SR/UV.

### G. The page fetches and computes on its own schedule, and nothing cached is shown first (15)
Symptoms:
- Boot takes 26 requests. A serial chain runs html → scripts → csrf → secrets → settings → list. There are duplicates (`characters/query` ×6). `horde/status` costs 550 ms at boot, and every module revalidates on each load. (P:556)
- Switching character "sometimes takes so long". "measuring tells you NOTHING because what if something's fucking blocking the switch". (U29, P:558; R 10-29)
- A switch awaits every listener of CHAT_CHANGED and the other chat events, extensions included. (P:559)
- The swipe picker takes 30 s+ on a phone: one count request per row, drawn only after all 50 answer. (P:555)
- Greetings search in character info freezes the UI on mobile over Tailscale. The swipe modal is slow (1k greetings). (U29 FREEZE, P:541)
- 28 page-side token-counting call sites remain, in 10 files. (P:555)
- "Opening characters is very slow (the page-side half)". (CL24, BL 2a)
- Creating a character "takes very long on a huge library". (U27 CC1)
- Favoriting takes a while to show in the list. (U12, CL9 fixed)
- Renaming a lorebook re-renders the whole world info drawer. (WI5, BL §3 user 10-02)
- Clicking toggles in the regex drawer "forcibly rerender... a lot of stuff". (U23, DR3)
- The character list re-render ignores the query. (U16, CL12; fixed 68474d958)
- Common 3-word phrases take 18 s at 400k cards: "not an open problem, lru cache". (U29, P:533)
- A local import of 1,171 cards took 31 min. (U16, CL15)
- File-system threads read 107 GB, likely because full PNGs are read while browsing (unconfirmed). (P:546, P:548)

How it got in:
- The audit's root cause (see B).
- The audit listed about 39 `getTokenCountAsync` sites (Audit §11). Step 10 (8721932af) converted only message drawing, and nothing banned the rest (P:555). Upstream has 55 `getTokenCountAsync(` lines (grep).

Model: one design for boot, switch and dialogs (P:558):
- The last-seen view from the client cache is shown at once (stale-while-revalidate, keyed by id plus version).
- One streamed request follows.
- Windows are bounded.
- Derived data (counts, matches) is pushed after, by the server.
- Nothing waits on extensions or counts: listeners are notified, not awaited, which is safe with a bound context (P:560).
- The app shell comes from a service worker, with content-addressed scripts (P:556) and content-addressed thumbnails (P:548).
- The server keeps an LRU of query results (P:533).
- Budgets are tested under a "phone over Tailscale" profile (P:557). Requirement: "sending a message should have <200ms latency over vpn and 3g" (CLAUDE.md).

Agreed doc: ALT settles it for one surface ("Opening shows the dialog at once…", streamed list, counts pushed). Boot and switch have no doc. Recommendation: generalise ALT's rules into one doc.

### H. No shared visual and interaction vocabulary (UI1) (15)
Symptoms:
- "the same kind of thing looks and behaves differently from panel to panel… checkbox rows vs toggles vs selects… 'save' meaning save, update, apply or nothing". (UI1, user 10-27, P:464)
- "UI consistency overhaul: see ~/git/lee-app/, ~/git/cyoa/, ~/git/pteraworld/src/games/ for better prior art". (U29, P:537)
- The fullscreen character list and the sidebar list use different colors; the multiselect toggle doesn't highlight. (R 09-12)
- "all tabbars should look identical". (R 09-12, 09-23)
- Find-and-replace was unstyled (U12, ED10 fixed). Macro autocomplete was unstyled (U12, ED21 fixed). The paste options have a white background and are "just bad in general" (U12, ED17).
- "the buttons on the toolbar are weird; dropdown for block type is unintuitive" (U12, ED19). The live editor toolbar is "standard but bad UX" (user 10-24, ED27).
- The find-and-replace presets lack search, "save the current search", "save the ticked presets as a list" and close. (U12, ED18)
- "the circle buttons (and 'clear all filters' button) after the search bar are weird and inconsistent" (U16, TS6). The filter pills are "poorly designed" (user 10-27, P:516).
- The Excluded filter's X is off-centre. (TT31)
- Long tags in management need tooltips. (U12, CL26)
- `__transparent` has an odd size and is square in the grid. (U29, P:536)
- Appearance choices have no preview. (SR §6; Inv-US flags b; Q6)
- "the preview should be the DEFAULT view". (R 09-23)
- "modern ui conventions, more 'responsive' feeling". (U12, DR21)
- The ports so far (backgrounds, settings) copy the old layout one to one. (P:464)

How it got in: "controls follow the old code's layout, not what the user thinks they're doing", and ports copied that layout (P:464).

Model (UI1, P:464):
- Write one model first: the kinds of surface and when each is used; how a choice, an edit, a save and a level are shown; wording rules.
- One component per kind: toggle, tab bar, list row, filter chip, preview tile.
- A choice's preview is its default view (Q6).
- Every area's rewrite is held to the model.

**D1 (decided 10-29)**: the direction is the user's own projects (lee-app, cyoa, pteraworld's games), surveyed and
written down as one page: `ui-style.md`. Modal vs drawer is decided per job from that survey, not once for the app.

Agreed doc: `ui-style.md`.

### I. The conversation tree has no settled UI model (chats, bookmarks, branches, alternatives) (14)
Symptoms:
- "CHATS SHOULDN'T FUCKING EXIST" and "a chat should be a minimal shim over a bookmark". (R 09-13, 09-26) CH11 is open: the U1 answer of 10-02 was never recorded, and the step 16 questions are unanswered (P:54).
- "branch_name is not bookmark is not chat" and "bookmarks are fucking optional and not part of the fucking tree structure". (R 09-15, 09-20)
- "ideally need full unification of group chats with regular chats bc why the hell are they different". (R 09-15)
- "why is there no ui for it (inserting, cutting, deleting, etc all either branch or inplace)" (CH13, user 09-27). Real deletion: "not sure how that would work at all" (CH14, user 09-29).
- Better bookmark navigation "needs explicit design". (CH27)
- "how would you bookmark a fucking message". (R 10-29)
- Export works only from a bookmark, not from any message. (U12, CH18)
- Group greetings: one swipeable turn of all members' greetings, never designed. (CH16)
- A greeting's versions, origin and place. (Q10b, P:566-570)
- "Save as new alternative" appends instead of placing the new one after the current. (P:526)
- "Delete Swipe" is offered only on the last message. The picker is disabled for user messages that have alternatives. (Inv-MB bugs 6, 7)
- Move up/down was removed; reordering moved to CH13. (P:526-527)
- The greetings popup and the swipe picker were two surfaces for one thing. (ALT header)
- "show this greeting in the chat" is missing. (P:552)

How it got in: the tree store was built before its UI (CH13, user 09-27). Chats, bookmarks and branches were conflated in code (the user's words above). Unknown beyond that.

Model:
- ALT (settled): one surface for a message's alternatives, greetings included.
- CN (settled): every chat has a name, and the name is its id.
- Q10b (specified 10-29): origin and place, lineage.
- CH11 (planned): the chat-as-bookmark shim.
- CH13: a move on a new branch, or in place with a preview of what's affected (P:526).
- Recommendation for CH14: delete at once, with undo from engine history (UV "Confirm message deletion").
- Recommendation for CH16: group greetings are the alternatives of message 0 (ALT targets).

Agreed doc: partly (ALT, CN). The content of CH11's open questions is unknown here. Re-derive them before asking.

### J. Hidden gestures and modifiers; behaviour differs by device (12)
Symptoms:
- On phones the swipe counter opened only on long-press; a tap did nothing. (P:562; fixed 112c5a443)
- The counter is 40×15 px: "swipe picker trigger is also too small on phone". (TOUCH, P:563)
- The globe, Chat Lore and persona lore buttons open a different action on Shift/Alt-click or long-press. (Inv-CB 6, 7; P:562)
- Shift-click in Connected Personas removes a connection. (Inv-CB 8)
- "long press is garbage ux BC it's incredibly slow", "two gestures, too slow", "double tap too slow". Every touch proposal for message actions was rejected. (R 10-29; P:564)
- "mobile ux like swipe gestures/swipe menus would be cool"; "is there anything in backlog about swipe/swipe-from gestures?" (TOUCH, P:563; nothing was designed before then)
- The arrow keys swipe only the last message, though any message can swipe. (Inv-MB c1/c2)
- Enter does nothing on Copy, Prompt, Copy reasoning and Copy code (pointerup only). (Inv-MB bug 3)
- Firefox: the top-bar drawers don't slide in or cut the chat. (DR4, BL §3)
- iOS desktop with the bar on top: the chat stays full width and the sidebar covers it (DR14). The real-device check is pending (DR23).
- Force Mobile View (fork 413560a71), a separate Drawer Bar (Mobile) value, and a mobile-only Compact Input Area. (Inv-US; UV)
- The MoonlitEchoes theme makes the whole message bar hover-only. (Inv-MB global rules)

How it got in: Force Mobile View 413560a71 (fork). The rest is unknown.

Model (direction settled 10-29, P:565):
- Marking menus on messages: touch and flick, the direction picks the action, the menu shows only on a pause, one motion, no delay, no added control. Left and right are previous and next alternative. Linear marking menus are used where radial doesn't fit.
- Gestures replace controls; they never add to them (P:563).
- No modifier variants: a secondary action is a command in the context menu and palette (P:562).
- Every command is reachable by keyboard through the registry (A).
- Layout follows window width, not a device mode (UV).

UV's "Expand Message Actions" and "Gestures" rows said long-press opens the message's menu; corrected 10-29 to the
marking menu.

**D2 (decided 10-29)**: the message marking menu's directions: left / right = previous / next alternative, up =
bookmark, down = edit, the diagonals for the next most used commands (from the registry, rebindable like any
binding). An edge swipe opens the left or right panel.

Agreed doc: `ui-style.md` (Touch).

### K. Search and filters have no single model (11)
Symptoms:
- `"a b c"` doesn't show the results of `name:"a b c"`, "which is insane". (U16, TS4; again 10-27, P:517)
- Favourites plus a search term missed name matches. (TS17; aa6ffd2ed)
- "filter pills should not take up space in the search bar"; "inline inside search bar is garbage ux". (U12, U16; TS5)
- "what if i wanna hide certain creators without affecting sort order": searching replaces the user's sort with search order. (U16, TS7)
- Banning tags or authors per user. (U23, CL25)
- The tag dropdown in character info should sort by frecency. (U12, TS2)
- Searching for a tag named `10/10` is broken. (U12, TS3; not reproduced)
- Filters on card facts: has a lorebook, number of greetings, length, tokens. (TS16, user 10-26)
- Browse chats by latest message (U23, CH9). Chat and bookmark tagging plus search across characters (CH17).
- Swipe selection has no search. (U16, CH7)
- "tag search (as with character search): they should behave intuitively". (R 09-26)

How it got in: separate mechanisms for conditions, tags, favourites and ranges, which Q11 replaces (P:516). Text-as-source was rejected as a bandaid (P:516).

Model (Q11, P:516):
- One condition tree `{field, op, value}` with and / or / not.
- One field schema drives the menu, the chips, the server query and the help.
- The search box takes free text only; `field:` opens autocomplete and becomes a chip.
- Chips are keyboard-first.
- The server owns the view.
- One tag system for every entity (P:545).

Recommendations:
- TS7: the user's sort stays unless they pick relevance.
- TS16 tokens: counted by the current connection's tokenizer through the count store. This is a choice of definition, not taste.

**D3 (decided 10-29)**: the filters sit in their own row under the search, shown only when there are filters.
Space for the row isn't reserved while there are none: it appears only as the result of the user's own action (adding
a filter), which is not a layout shift of what they're reading.

Agreed doc: none in docs/design.

### L. The page treats its DOM and events as data (11)
Symptoms:
- A character's lorebook link is kept as jQuery data on an `<option>`, and the option is selected by its translated text. (Inv-CM id-reuse section)
- A hidden `#fav_checkbox` mirror is kept for whole-form saves. (Inv-CB 5)
- The globe button selects a More… option and fires `change` to run an action. (Inv-CM 1; Inv-CB 6)
- The palette dialog clicks `#rm_button_selected_ch` to reopen the editor. (Inv-CB 3)
- Connected Personas re-triggers its own button, which stacks popups. (Inv-CB bug 5, inferred)
- Reasoning Cancel triggers `.mes_reasoning_edit_cancel:visible`, which is itself. (Inv-MB bug 8)
- The Ctrl+Up guard reads `.css('display')`, which is always true, so it throws when there's no user message. (Inv-MB bug 5; fixed P:551)
- Extensions insert buttons into the live message template, so messages already drawn don't get them. (Inv-MB #2, inferred)
- Applying a chat's settings in place re-triggers the panels' input handlers, which save them as the user's. (P:442)
- Settings were saved on boot (colour pickers, max context, applyTheme). (ST3; fixed 2f4271dc7)
- Applying a context template sets two switches with an `input` event their handlers don't listen to, so they aren't saved. (SR §7)

How it got in: upstream-style whole-form saves are kept for extensions (Inv-CB 5, inferred there). Unknown beyond that.

Model:
- State lives in a store (the server's views plus the page's view state), and the DOM is rendered from it, one way.
- An action is a command called directly, never a synthetic click or change.
- A settings write is an action with a target level, never a side effect of an input event. ST1 step 11c (P:459) needs this.
- Extension compat goes through wrappers outside our flow (Audit root cause).
- Recommendation: lint bans in our code on `.trigger(`, programmatic `.click()`, and `.data()` used as state.

Agreed doc: none.

### M. One text has several renderings (two markdown parsers, separate field pipelines) (11)
Symptoms:
- Two parsers are kept in step only by a parity corpus, and strikethrough flanking drifted (ED31). `~` was struck in the editor but not in chat (ED32, fixed 055b12866).
- Rendering differs between chat and character info fields (CL29). "the character info drawer's field rendering is wrong in places" (user 10-26, P:409).
- Custom HTML doesn't render in the description's rendered form. (U23, CL4 fixed)
- In example messages, newlines aren't line breaks. (U12, ED4 fixed)
- `q::before/after` quotes and the quote colour are missing outside `.mes`. (ED6, fixed)
- Macro highlighting is inconsistent (U12, ED20 fixed). Coloured macros lose their colour inside custom-colour blocks (U25, ED35 fixed).
- `<img>` is broken in the editor: the lezer grammar lacked `/>`. (U25, ED36; fixed 9d2195cf3)
- The cursor lands on the wrong line on a click (ED34, ED26 fixed). A click on the preview starts the edit at a guessed position (ED29).
- "this is stupid, why aren't they part of the parser itself". (R 10-26)
- "hiding formatting… discord may be better prior art for us"; HTML comments and images always visible; "not sure about ruby text". (U23, ED1)
- Search highlights in rendered rows need a mapping from source to output. (ALT "Rendering")

How it got in: a hand-written lezer grammar for the editor beside marked for chat (ED31). Field previews use `renderMarkdownLiteralTags` / `formatCreatorNotes`, not `messageFormatting` (P:409).

Model (settled 10-26, P:425):
- One parser: marked plus extensions.
- The editor's tree is built from marked's tokens.
- Quotes and macros are marked extensions.
- Character info renders exactly as chat does.
- Goldens are frozen first.
- "do actual features first; ED31 after" (P:426).

**D4 (decided 10-29)**: the formatting display is Discord's: markup stays visible, dimmed beside its effect (as
cyoa's `.cm-syntax`, `ui-style.md`), never hidden. HTML comments and images are always visible. Inline HTML shows its
tags dimmed with their effect; block HTML shows its dimmed source with its render under it (already built, ED28).
Ruby follows the inline HTML rule.

Agreed doc: P:425 and `ui-style.md` (Text). The one-parser model moves to docs/design with step 6.

### N. Steps called done that weren't; rules not enforced (10)
Symptoms:
- Token-counting step 10 was recorded done with most of its listed sites unconverted, and there's no lint ban. (P:555)
- The thin-client rows were taken from a stale "Nothing built" line. (P:24)
- "i thought that was fucking finished WEEKS AGO". (R 10-23)
- "that violates thin client. didn't we do multiple audits of where requests are sent from". (R 10-29)
- Reported again after being "fixed":
  - occlusion (U12 → U16 → U23);
  - bookmark names (U16 → U23 → U25 CH32);
  - overswipe (U23 "*still*");
  - per-macro colours, "was never built?" (U25);
  - the example messages UX, "we never did" (U12, U23).
- Regressions:
  - ED33 came from 2dd9ab32b (P:380).
  - Imports stopped being reflinked after 3b1754a82: "100% a regression" (P:547; R 10-29).
  - Avatar zero size was "a regression" (U12, CL8).
  - Tag `10/10` was "a regression" (U12).
- Bandaids landed 10-29 (58cb79486, 38deddc21), to be removed with Q10. (P:561)
- Inventory bugs were fixed one by one during the same days. (P:550-551, against P:553 "until then no bandaids")
- Orphaned test servers spun a CPU each for more than an hour: "unacceptable that they were allowed to spin". (P:577)
- "posthoc fixes is unacceptable since it means context and architecture are already poisoned", and "fixing one specific thing leaving everything fucking else unfixed". (R 10-29)

How it got in: "a rule existed, nothing made the wrong thing impossible" (P:555). Steps were recorded done without a check that their listed sites were at zero (P:555).

Model:
- The model is agreed before an area is built (P:553).
- Each rule in it ships with its lint rule or test, written with the model, not after a failure. (global CLAUDE.md; the user's "add to no-restricted-syntax?", R 10-29)
- A step is done when that check shows zero listed sites.
- A reported symptom goes to its problem here, not to a fix.

### O. Import has no single model (9)
Symptoms:
- Three importers (core, CharacterLibrary, STCardsBrowser) cover different sites and flatten cards differently. (Inv-I §4-5)
- Core has no dedupe (the same URL twice makes a second character) and no update check; Replace overwrites. (Inv-I core quirks)
- Perchance re-sync is broken (inferred). A RisuRealm URL with a query string fails. A Pygmalion error body can be written as the avatar. (Inv-I)
- CharacterLibrary and STCardsBrowser write V2, so V3 fields are lost. (Inv-I §5)
- Imports aren't reflinked: each import is a full new file. (P:547)
- Card tags on import are handled by a setting. (Inv-US 4145; UV)
- "zero friction for everyone including but not limited to browsing cards". (U29, P:573)
- Groups have no import/export format. (CL30)
- Lorebooks can't be imported from a folder the way cards are. (WI9)

How it got in: site downloaders built into `content-manager.js`, plus two outside packages (Inv-I).

Model (MOD, settled):
- Input handlers: pasting, dropping and Import are one lookup.
- An importers package with one module per site, on the server, with fetch to its own hosts only.
- Never flattened.
- Update checks belong to the package.
- The sites rule.
- Recommendation for P:547: keep the original as a reflink and serve the image or thumbnails only.

Agreed doc: **settled** by MOD.

### P. Names aren't clear to a layperson (9)
Symptoms:
- A plain-language pass over all UI text: "ONLY when the vibe is finalized". (DR20; R 09-29)
- Many tooltips start with "[character]". (U16, CL13 fixed)
- "Copy" copies to the clipboard while "Copy this message" duplicates the message into the chat. Two controls share the tooltip "Toggle media display style". (Inv-MB bug 9)
- "Character Settings Overrides" are per chat. (Inv-CM 4)
- "Show {{char}}: / {{user}}: in responses" is labelled as display but trims the output, and when off deletes a reply that starts with "User:". (Inv-US; UV)
- "it should be absolutely idiot proof levels of clear that {{macro}} is not sent to the llm". (R 10-25; ED37 done 387f79adc)
- The backgrounds `__transparent`, `_black` and `_white` are "named weird". (U29)
- "387788 characters hidden" means nothing. (TS18; fixed 72b82f515)
- Auto-generated `b\d+` bookmark names are exposed to extensions (U16, U23, CH10). A session showed as `s<uuid>.<tree>` (U25, CH32).

How it got in: CH10 came from auto-generated names exposed to extensions (U16). Unknown beyond that.

Model:
- "ideally all names should be clear and unambiguous to a layperson". (R 09-25)
- A label says what happens, where it happens.
- CN (settled) for chat names.
- The wording pass runs after H's model and vocabulary (R 09-29).

### Q. Old code carried over (8)
Symptoms:
- "wrong. any old is the biggest risk"; "most stuff should be rewritten otherwise the codebase keep poisoning itself"; "ST is absolutely not worth 115k lines of garbage". (R 10-26)
- The ports copy the old layout one to one. (P:464)
- Old-code bugs remain until ported (Q9, P:499; SR §7):
  - exporting a theme overwrites it, and importing one doesn't apply it;
  - context template switches aren't saved;
  - Bind Model to Templates always saves.
- jQuery UI tab leftovers and dead CSS: "jquery is garbage slop". (DR19; BL §3)
- Duplicate implementations: two timestamp parsers (GE18), four canonical-JSON serializers (SS2), server copies of enums (SS1).
- Commented-out controls in `index.html`, and a typo'd block name. (Inv-CB, Inv-CM, Inv-US d)
- The page macro engine is kept only for extensions' `substituteParams`. (MA1, P:397)
- "why the fuck do we still have webpack". (R 10-26)

How it got in: the Audit's root cause, and ports done as one-to-one copies (P:464). The user: "direct port of old code will be cheapest no? it just doesnt have to be bug for bug" (R 10-26). This was later followed by "any old is the biggest risk" (R 10-26).

Model:
- Each area is rewritten from the agreed model in `packages/areas/<name>` (P:464).
- Upstream's exports and events become compat wrappers outside our flow (Audit).
- "our upstream parity requirement is compat not behavior" (R 09-29). Bugs aren't reproduced (R 10-26).
- The old code is deleted with its port.

### R. State and modules: what the core can't yet express (from the Noodle and Talemate research, 10-29)
Not symptoms: capabilities. The user asked for "parity with most other frontends in terms of capability not
ad-hoc-ness" (U29), with Marinara Engine's Noodle "an example of something that must be possible post state refactor".
What those two do, read from their code and docs (Marinara Engine with the Noodle package; Talemate):
- **Noodle**: a package with declared permissions (chat read/write, network, routes, storage, UI) that runs a fake
  social network for the user's characters. It writes posts with one model call, refreshes on a schedule in the server
  with no tab open, and feeds back into chat prompts. Even so, its tables and migrations live in the engine's code, and
  its state can't be rewound.
- **Talemate**: a scene with several agents (narrator, director, summarizer, world state), each on its own model, and
  node-graph scripting in which the turn loop itself is a graph. State has scopes and change events. Rewind forks a
  whole-scene snapshot.
- **Where this app is already ahead**: state layer 1 (`engine/src/store/state.rs`) is correct per branch and per swipe
  by construction (the state at a message is the fold of the changes on its path), at O(changes). Both of them copy
  snapshots.

The capabilities the core must provide, so that each of those is a module (Noodle itself, trackers, quests,
inventory, a director, layered summaries are not core). Missing outright:
1. **Modules declare their own stored entity kinds and indexes** through the engine, with a capability scoped to
   their kinds (Noodle's tables in the host are the failure this prevents).
2. **A turn pipeline of named stages** (build context, before generate, generate, after generate, finalize). Modules
   register steps that declare what they read and write, their order, deadline, and whether they run beside
   generation. What a turn writes is recorded as PRODUCED changes, so a swipe or regenerate discards it by
   construction. Choosing the next speaker (user, a character, a narrator, a director) is a step too.
3. **Stage events with typed, editable payloads**: a hook returns a patch. A listener that fails or times out is
   skipped and shown, never fatal.
4. **Turns started by the server** (scheduled, on idle, on a state change), running the same pipeline as a user turn
   with the tab closed: persisted schedule state, retry, cancellation, and connection admission so background work
   waits for the user's own requests. Results reach tabs as normal view pushes.
5. **Per-audience views of history**: a message carries what each character sees (sees / doesn't / sees this
   version), and the prompt builder takes an audience, so "what X knows" is an input and never a copy of the chat.
6. **Module writes as proposals** the user accepts or rejects, in the same change records, by a per-module, per-kind
   policy (needed before proofreader agents, EX5, are safe).
7. **Module-to-module interfaces**: named, versioned (image generation, retrieval, TTS), declared as a dependency and
   received as a capability.

Partly there (the design names the mechanism, the part listed is missing):
8. State owned by an entity beyond one chat tree (a character across chats, a persona, a shared world, a module's own
   timeline), with the same change and revert log and its own positions; and what a chat reads from it at a message is
   defined (a time or a pinned version), so a regenerate is reproducible.
9. Typed, path-addressed state with declared schemas, enforced on every write; a generic state editor and HUD follow
   from the schema.
10. Model access for modules: a completion, embedding, image or classification under a role the user binds to a
    connection (main, helper, decision, embedding, vision, image), never seeing credentials; structured output
    against a schema; token counts returned.
11. The prompt builder callable for any context (a timeline, a scene), with condition state (sticky, cooldown) stored
    in whatever that context owns.
12. Providers reading across contexts only through a read capability the other context's owner grants.
13. Conditions over typed state with comparisons, and model-judged conditions cached per position (a swipe reuses
    the answer), with a defined no-answer default.
14. Model-callable tools as one kind of command: an argument schema, validated on the server, writes recorded with
    author `model`.
15. One scripting runtime that reaches all of the above; scripts are data at a level (card, chat, user, package),
    resolved with level precedence; a graph editor, if wanted, is a view over the same runtime.
16. Data derived from a message range (summaries, embeddings, snapshots), keyed by that range's content: an edit
    inside the range invalidates it, a branch sharing the prefix reuses it.
17. Optimistic concurrency on every write: an action names the version it was made against; a write over newer
    state from another author is refused with the newer view.
18. Module UI surfaces from packages: a top-level page, widgets and panels, under the module's capabilities; unread
    counts and notifications are views.
19. A versioned contract per extension point and a manifest (capabilities, hosts, hashes); an older core refuses a
    package that needs more, cleanly.
20. Randomness and time as state: seeded draws recorded as changes (a swipe redraws, a revert restores); a scene
    clock as a typed state key that steps advance.

Where they live: the points and capabilities go into `modules.md` (its "Still to specify"); 2, 3, 5, 10, 11 shape Q1's
builder interface, so Q1 takes a context and an audience from the start rather than "the chat"; 8, 9, 13, 16, 20 are
the state layers after layer 1 (EX5).

---

## 3. Build order, and which queue items each problem's work absorbs

Dependencies first. Each step starts by writing its model into docs/design together with its lint rules and tests (N).

| Step | Problems | Work | Absorbs |
|---|---|---|---|
| 0 | all | This sit-down. Agree the models and answer D1-D4. Correct UV's long-press rows. (Done 10-29.) | — |
| 1 | B, G, L | Views and cache: server-owned versioned views; the client cache shown first; one streamed request for boot, switch and dialogs; `getContext()` bound per chat, listeners not awaited; store first, then show; actions as commands, never synthetic events. Lint bans: page-side token counting, `.trigger`/`.click()` dispatch, `.data()` as state. Remove the 10-29 bandaids. | **Q10** (alternatives is the first instance, in progress); **Q8** (Guess: the stop path's page state; P:469 says "page-side bug… or the test's held response") |
| 2 | C, H | Page shell: the layer, clip, focus and Escape model; slots as stacks; reserved space; the component vocabulary (D1). | — (UI1, DR11, DR22, DR16) |
| 3 | A, J, D | Command registry: palette, context menus, bindings on the server, marking menus (D2), keyboard parity. The notify module and toast rule, applied with Inv-T's verdicts per area. | **Q7** |
| 4 | E, F | Prompt and settings on their places: Q1, then Q3 and Q4, then Q2, then Q5 (with ST1 step 11, which needs L's "writes are actions"), then Q6 (needs H's preview tile). | **Q1, Q2, Q3, Q4, Q5, Q6**; **Q9** (each old-code bug goes with its area: themes with Q6/Appearance, context template and Bind Model with Q2) |
| 5 | K, I | Search: the condition tree, the field schema, one tag system (D3). Tree: lineage and place; the chat-as-bookmark shim; tree edits; delete with undo. | **Q11**, **Q10b** |
| 6 | M | One parser (after features, P:426; before the alternatives search highlights need exact positions) and the formatting display (D4). | — (ED31) |
| 7 | O | Input handlers and the importers package. | — |
| 8 | P | Wording pass, once the vibe is final (R 09-29). | — |
| 9 | R | State layers after layer 1 and the module capabilities (R 1-20); Q1's interface already takes a context and an audience (step 4). | EX4, EX5, EX1, EX2 |
| — | N, Q | Not steps of their own. N is how every step is held. Q is met by rewriting each area from its model, deleting the old code as each port lands. | — |

## 4. Unplaced symptoms, and requests that aren't symptoms

Symptoms whose design problem the sources don't show:
- Editor key behaviour:
  - Ctrl+I makes italics bold (U12, ED13, fixed).
  - Undo/redo and Ctrl+Left/Right differ from the browser (U12, ED14).
  - Shift+Delete clears the field (U12, ED15, fixed).
  - Paste defaults to HTML (U12, ED16, fixed).
  - Clicking and arrow keys behave oddly (U12, ED11).
  - Guess: the editor reimplements browser text editing. Unverified.
- Other editor and display symptoms:
  - wrong cursor colour (U12, ED5);
  - an edit starts scrolled to the middle (ED8);
  - list gaps (ED9);
  - the cursor on the "-1th" line (CH28);
  - the cursor line in 'Bunnify Anyone!' (ED30).
- The greetings number input is too narrow (U12, CL7).
- The avatar has zero size in character info (U12, CL8).
- There's no greeting delete in the panel (U12, CL5).
- The right arrow is highlighted on greetings and user messages, an operator-precedence bug (Inv-MB bug 4, fixed P:551).
- Thinking blocks lose their block form after a re-render (U12, CH5, fixed 3c420da62).

Feature requests on record. These aren't symptoms, and the problems above don't absorb them:
- AU1 (volume and autoplay). The user asked for "very prominent… to avoid earblasting" (U23); UV now puts the
  default volume and autoplay where embedded audio is first met, as well as at the player.
- AU2.
- WI1, WI2, WI6, WI8.
- CL17, CL18, CL32.
- EX1-EX6, GE15, IC13.
- Install speed, budget tracking, marinara/talemate parity, and "{{char}} mention brings in definitions" (U29).

## 5. Decisions (decided 10-29, as proposed)
- **D1**: the direction is the user's own projects, written down in `ui-style.md`; surface kinds per job (H, C).
- **D2**: left / right = previous / next alternative, up = bookmark, down = edit, diagonals for the rest; edge swipes
  open the side panels (J).
- **D3**: the filter row sits under the search, shown only when there are filters (K).
- **D4**: Discord-style: markup visible, dimmed; HTML comments and images always visible (M).

Everything else above was a recommendation and is now the agreed model. Also corrected with this: AU1 goes where the
user first meets embedded audio (UV), not only at the player.
