# Backlog

- The whole app's UX, from first principles: fewer settings, settings next to what they act on; one consistent UI (prior art: ~/git/lee-app, ~/git/cyoa, ~/git/pteraworld/src/games); too many affordances, gestures replace controls. Every area held to UX principles as a whole, not to a list; among them, no unnecessary mouse travel, clicks or steps, no clutter, nothing to memorise, no condescending wording. One area at a time, each to the owner, after worldbuilding.
- Clipping stays optional; occlusion must be impossible for any overlay to miss (the typing indicator extension doesn't clip the chat).
- Touch: swipe gestures and swipe menus; the swipe picker trigger is too small on phones; swiping to change the character management page doesn't work.
- Greeting and swipe alternatives: an edited greeting keeps its place; duplicates follow their origin; not getting lost among 10-100 edits; re-parenting. Jump to a swipe / show a greeting in the chat, in the modal and outside it.
- Search: filter pills; keyboard use; `"a b c"` vs `name:"a b c"`; repeated searches cached (LRU).
- Startup steps not needed, let alone in series; a service worker. Switching character sometimes takes very long.
- Tests simulating packet loss, slow connections, high latency.
- Groups are still downloaded whole: every `getCharacters()` fetches `/api/groups/all` (`public/scripts/group-chats.js:932`, `src/endpoints/groups.js:327`); the page must hold only the groups it shows, as it now does for characters.
- The character list's creator-notes prefix is 0 (`LIST_CREATOR_NOTES_CHARS`, `public/scripts/hash-utils.js`) until the list cards get a maximum width or the owner gives a length.
- Smaller thumbnails (75% webp or lower, 100-200px max), cached by the client, served at the image data's hash.
- Tags on bookmarks, messages, greetings. Favourite tags, not a binary favourite (e-hentai's model as prior art). The tag manager is awkward and out of the way.
- A {{char}} mention could bring in that character's definitions.
- Guided Generations existing implies missing core functionality.
- Backgrounds: `__transparent`, `_black`, `_white` named weirdly; `__transparent` odd size and square in the grid; backgrounds part of the theme, on the cascade.
- A session on another device on an earlier message mustn't break; fix the desync.
- Page blur (switching app on a phone) closes character info.
- An empty thinking block is not the same as no thinking block (gemma inference breaks otherwise).
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
- Upstream compat breaks (`id: this_chid` in CHAT_LOADED and the plan's open list); GROUP_MEMBER_DRAFTED / `findGroupMemberId` payloads.
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
