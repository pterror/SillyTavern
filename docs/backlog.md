# Backlog

- The whole app's UX, from first principles: fewer settings, settings next to what they act on; one consistent UI (prior art: ~/git/lee-app, ~/git/cyoa, ~/git/pteraworld/src/games); too many affordances, gestures replace controls. Every area held to UX principles as a whole, not to a list; among them, no unnecessary mouse travel, clicks or steps, no clutter, nothing to memorise, no condescending wording. One area at a time, each to the owner, after worldbuilding.
- Clipping stays optional; occlusion must be impossible for any overlay to miss (the typing indicator extension doesn't clip the chat).
- Touch: swipe gestures and swipe menus; the swipe picker trigger is too small on phones; swiping to change the character management page doesn't work.
- Greeting and swipe alternatives: an edited greeting keeps its place; duplicates follow their origin; not getting lost among 10-100 edits; re-parenting. Jump to a swipe / show a greeting in the chat, in the modal and outside it.
- Search: filter pills; keyboard use; `"a b c"` vs `name:"a b c"`; repeated searches cached (LRU).
- Startup steps not needed, let alone in series; a service worker. Switching character sometimes takes very long.
- External media: replace `forbid_external_media` (`public/scripts/power-user.js:351`) and its per-chat allow (`public/scripts/chats.js:838-849`). Nothing external is fetched without the user's action, not even once on import (that still tracks, as email shows); shared content (cards, worlds, their looks' fonts and pictures) carries its own files by hash; anything else external waits in place and loads by a decision per source, remembered.
- Tests simulating packet loss, slow connections, high latency.
- `MacroValuesFromServer` "a character mention's card shows its creator's notes…": the hover card never opens (fails 8-9 of 10 alone, at c62c7316b and after).
- Library pushes still only say that something changed, and the page pulls: a character or group change (`data: {}`) makes it read `/api/characters/changes` (and `/api/characters/batch` for a held one); `groups-changed`, `tags-changed` and `views-changed` re-read too; actions that change characters call `getCharacters()` after their own request (a fav toggle is four requests). The push carries what changed; an action's answer carries what it changed.
- A chat state push for another tab's change is dropped when it arrives before this tab has taken the place its own send or select moved it to (`takePushedState`, `public/scripts/metadata-store.js`), so the tab keeps the state without that change until the next push.
- e2e flaky or failing at staging and after 6682bb45f: `SearchIndexUpdated`, `DrawerEditLock` (the same test every run), `DrawerFrontOrder`, `ReasoningSurvivesRerender`, `AutoFixMarkdownGone`, `GenerationStop`, `TagRestoreKeepsAssignments`; server `chats-import`, `chats-save`, `chats-save-compat`.
- Typing `/` into the chat box's editor shrinks `.cm-scroller` for ~100ms (32px to 29px; 1px at staging), so the send form shifts and the slash command list placed in that window overlaps the editor by 3px until the next placement; `ChatBoxLiveEditor` "the slash command suggestions show above the editor" fails 5 of 6 since boot got faster without extensions.
- `RawActionSendRequestLog` UI cases time out on clicks (a URL autocomplete covers the connect button), more with 4+ workers: the e2e setup leaves state between tests or races the page.
- The character list's creator-notes prefix is 0 (`LIST_CREATOR_NOTES_CHARS`, `public/scripts/hash-utils.js`) until the list cards get a maximum width or the owner gives a length.
- Smaller thumbnails (75% webp or lower, 100-200px max), cached by the client, served at the image data's hash.
- Tags on bookmarks, messages, greetings. Favourite tags, not a binary favourite (e-hentai's model as prior art). The tag manager is awkward and out of the way.
- A {{char}} mention could bring in that character's definitions.
- Guided Generations existing implies missing core functionality.
- Backgrounds: `__transparent`, `_black`, `_white` named weirdly; `__transparent` odd size and square in the grid; backgrounds part of the theme, on the cascade.
- A session on another device on an earlier message mustn't break; fix the desync.
- Page blur (switching app on a phone) closes character info.
- An empty thinking block is not the same as no thinking block (gemma inference breaks otherwise).
- The chat box and reasoning editors sit outside chat's text classes (`public/scripts/chat-live-editor.js:60`), so chat's rules (`.mes_text blockquote`, `.mes_reasoning em`, ...) don't reach them; only the quote color is copied, as a second list (`public/style.css:7343-7358`). Putting the class on them draws its box too (`.mes_reasoning`'s border and padding, `public/style.css:460-469`; `.mes_text`'s line height and weight, `:1581-1594`), and code finds the rendered block by that class (`public/scripts/reasoning.js:1264`). The owner's to decide how those two editors get chat's look.
- Live editor: lists, code blocks, tables and rules aren't drawn as chat's elements; their elements bring layout (bullets, indentation, cells) that the written text already shows, so each needs a decision on what of chat's look the editor takes.
- Live editor: the cursor sometimes goes onto the wrong line; Shift+Home sometimes selects to the start of the next line; the editor for messages sometimes scrolls; find and replace and its presets are bad.
- Install as fast as possible without losing functionality; updating too.
- Zero friction for everyone, including browsing cards.
- Budget tracking, management, enforcement (money).
- Capability parity with other frontends (Marinara Engine's Noodle, Talemate).

## From the 10-03 backlog and the 10-12 / 10-16 lists (`.plans/2026-10-03-backlog.md` in `~/sillytavern-harness-backup-2026-10-17.tgz`)

Not checked one by one against the current code. Left out: the SQLite storage redesign, the migration-removal steps and the tags-consolidated plan, whose code (`character-metadata-db.js`, `sqlite-engine.js`, `src/migrations`) no longer exists since the engine.

Thin client and compat
- Send's silent failure: a failed append only reaches the console.
- Open a chat as one action: no writes on viewing, no page tokenizing, no 404 loop on never-chatted characters.
- Lorebook actions per entry and per field; rename as one server action. Rename character plus group membership as actions.
- Itemized prompts recorded by the server. Send, generate, select/swipe, bookmark/fork, delete/new chat each one action; `ensureOpeningRow` shouldn't be needed. Chat metadata per key. Token counts from the store.
- The frontend still has `main_api`.
- Persona per path ("'persona locked to chat' no longer makes sense"). Quiet prompt drop. Example messages server side and their UI (rendered, edited like a message, one turn at a time).
- Upstream data import (chats, group chats, IDB itemizations through a chat-file → bookmark map). The chat import route drops each message's other versions.
- Tokenizer leftovers: opt-in hosted count endpoints, request-time alias lookup, unresearched model families.
- Missing avatar in character info while it shows in management and chat.

Drawers / UI
- Firefox: top-bar drawers don't slide in and don't cut the chat.
- Renaming a lorebook re-renders the whole world info drawer.
- Greeting delete in the character info panel; greetings reset to the first after editing or adding; the greeting number input too narrow.
- `.macro_preview_content` has its own 90dvh max-height instead of the drawer's scrollbar.
- Distinct default colors for {{user}} / {{char}} / other macros.
- The "More..." `<select>` and the button rows everywhere.
- The fullscreen loading thing is a popup, not fullscreen.
- Links to ST docs should be internal docs.
- The hotkey list isn't checked against the real handlers; no rebinding, no palette.
- jQuery UI tab leftovers (`#extensions_settings_tabs`, dead tab CSS).
- iOS desktop with the bar on top: the chat stays full width and an open sidebar covers its edge.
- Plain-language pass over all UI text.
- Tree editing UI (insert, cut, delete, branch or in place); real deletion in the tree.
- Group greeting selection: one swipeable turn of all members' greetings.
- Greeting summaries / taglines (ccv2 extension, optionally autogenerated with a flag).
- Renaming a character from a pen icon / double click on the name, not the dropdown.
- Tooltips starting with "[character]"; long tags needing tooltips; favorite star clipping into the card border.
- Next page should scroll to the top, previous page to the bottom (only when already at the edge).
- Toasts with a details popup; copying could say so.
- Batch management of most things (e.g. quick replies), toggles for quick reply visibility.
- Arbitrary layout instead of movingUI: any action can be given a control (button, shortcut, gesture, placement).
- The client doesn't display generation errors (e.g. llama.cpp not running); the log spam around it.
- Can't export from an arbitrary message.
- Favoriting takes a while to update in the character list; reload force-restores the favorite pill.
- Creating a new character: can't add the first greeting, tags go missing.
- Closing and reopening character management loses its scroll position; on refresh it shows character management instead of an open chat.
- Formatting bar on the chat input overlaps quick replies / guided generations.

Editor
- Cursor color; q quotes and blue color outside `.mes`; space reserved for the toolbar; beginning an edit scrolls to the middle; ul gaps.
- Ctrl+I on italics turns them bold; undo/redo, Ctrl+Left/Right not like the browser; Shift+Delete clears the field.
- Paste defaults to HTML (should be text); the paste options UI.
- Macro highlighting inconsistent; macro autocomplete unstyled.
- `<img>` elements broken in the editor; thinking blocks losing their block after a re-render.
- Example messages' markdown treats newlines as normal markdown.
- LLM rewrite actions (tense, proofreading, person) with an inline diff.

Lorebook / world
- Worldbuilding tool instead of a lorebook editor; activation records and per-message trigger highlighting (replacing WorldInfoInfo).
- Card `enabled` vs ST `disable` on import; a book saying 19 entries but rendering none.
- Chat ↔ lorebook reverse map. Import lorebooks from a folder like cards.
- Per-branch lorebook entries; conditional entries (if...then); "scan depth cannot exceed 1000"; triggers and scan depth hidden on constant entries.

State and other
- State layers beyond layer 1 (time, meters, items, crafting, rollback, per-character histories, a composed turn pipeline, consistency agents); author's notes are the wrong model; multiplayer chats.
- State values can be defined by rules over other state values, not only set by events (a schedule is one case: "evenings: in the Tankard", where the time is itself just a value the world defines); things move in time and space. Nothing about time or place is built into the state layer, worldbuilding views (which lay out any ordered value as an axis) or activation (which reads the same state).
- Per-card scripted tools, sandboxed.
- Mad libs / multiple-choice greetings, more generic.
- Browse chats by latest message. Chat/bookmark tagging plus cross-character chat search.
- Banning tags, authors etc. per user; local vs exported tags.
- Encryption at rest (opt-in). A CLI for the engine and one for the app.
- `/duplicate` loses the favourite.
- Auto-install and management of llama.cpp / koboldcpp / ollama and models (optionally TTS and image gen).
- Local import took 31 min for 1,171 cards.
- /sysgen not using the selected request formatting.
- Console noise: an ordinary action logs nothing on success.
- A browser test reaches aihorde.net.

## From the owner's 11-06 review

- The whole codebase: about 260k lines against the 30k goal, 480 test files, and the issues below share one cause, no coherent architecture under the upstream-derived page. A top-down rewrite: the architecture first (core and modules per `docs/design/modules.md`, the page shell on interact), then each area rebuilt into it, its old code deleted in the same change.
- Opening a chat: `takeChatOpenAnswer` wires each part's answer by hand; a part that asks for something also takes its answer, so nothing is wired twice.
- Character management: names have no line cap; the arrow buttons shift as the position numbers change width.
- Messages: the edit bar is a separate UI with its own controls; buttons are small and inconsistently sized; the send buttons sit in a different element from the burger menu beside them. The WYSIWYG editor's UI needs a UX pass. `<details>` doesn't stop click-to-edit. CodeMirror shows comments as the HTML preview under the markup.
- UI consistency: every piece (the greetings/alternatives modal most of all) is built its own way; one component library (interact) and one design system.
- Greetings:
  - The card editor's greeting view jumps back to the first greeting some time after a greeting save, likely when the save's request completes.
  - An in-chat greeting equal to a card greeting links back to it (the other direction of "go"), so editing the card's updates the chat, and an edit in the chat can be applied to the card.
  - Editing a greeting in the chat twice with no message after it doesn't keep the first edit as a separate alternative.
  - An edit that becomes identical to an existing greeting or swipe goes to that one, with no duplicate.
  - Arrows on an in-chat greeting step through the card's greetings, skipping edits.
- Example messages: the input needs its redesign.
- Slowness and frozen UI: favouriting freezes the UI thread; invalidating a search and opening a card stall it.
- Trigger marks: shown for entries activated by any visible message, not only the latest reply. "Lorebook entries used for this reply" is redesigned with worldbuilding.
- Group chats: characters answering one at a time is slow and awkward; the narrator approach makes it hard to see who speaks, with no pictures. A group chat model that's good at both.
- Message styling per thing, cascading (character, group, chat, user, device) through the same levels as settings and looks, in place of dialogue colorizing.
- Lorebook names: trimmed on create but not on rename. Ordering global lorebooks needs a real order, not a leading-space hack.
- Embedded lorebooks identical to their card's book still sit in the lorebook list; once confirmed identical, they're removed.
- Shared code lives in the page's folder: `src/library-engine.js` imports `public/scripts/hash-utils.js`. Code both sides use belongs in a shared package.
- `LibraryEngine.query` is unreadable.
- Dependencies: lodash (18 files) and node-fetch (29 files) go, for the platform's own.
- `patches/` holds patch-package changes with narrating comments ("rhi.zone patch (2026-08)").
- `plugins/` is upstream's server plugin system, empty here; it goes like the extensions.
- Logging: "[Macro] Warning: Parsing errors detected" logs the whole prompt, thousands of lines. Best-in-class logging: short, structured, nothing dumped.
- interact: the components package holds every component, each split by technique into many files (combobox in ten), with test pages inside `src/` and the command bridge inside components although components know nothing of commands. Re-examined before more is built on it.
