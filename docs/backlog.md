# Backlog

Open requests, as the user put them. Older lists not yet checked against the code: `.plans/2026-10-03-backlog.md` in `~/sillytavern-harness-backup-2026-10-17.tgz` (sections 1-9, the 10-12 and 10-16 pasted lists).

## Running / queued (survive a UI redo)
- Layers: occlusion as a library (`packages/occlusion`), clipping the user's choice, right panels stack. Branch `layers-wip`.
- Thumbnails: webp at 75% quality or lower, 100-200px max dimension, client-cached, served at the image data's hash.
- An empty thinking block is not the same as no thinking block (gemma inference breaks otherwise).
- Tests simulating packet loss, slow connections, high latency.

## Waiting for the UI redesign (from first principles)
- The whole app's UX: settle the models first; fewer settings, settings next to what they act on; one consistent UI (prior art: ~/git/lee-app, ~/git/cyoa, ~/git/pteraworld/src/games); too many affordances, gestures replace controls.
- Touch: swipe gestures and swipe menus (marking menus on messages, left/right = previous/next alternative); the swipe picker trigger is too small on phones; swipe to change the character management page doesn't work.
- Greeting/swipe alternatives: an edited greeting keeps its place; duplicates follow their origin; not getting lost among 10-100 edits; re-parenting. Jump to a swipe / show a greeting in the chat, in the modal and outside it.
- Search: filter pills (not inline in the search bar, editable with the keyboard, text not left behind), `"a b c"` vs `name:"a b c"`, repeated searches cached (LRU).
- Startup steps not needed, let alone in series; a service worker. Switching character sometimes takes very long.
- Tags on bookmarks, messages, greetings. Favourite tags, not a binary favourite (e-hentai's model as prior art). Tag manager awkward and out of the way.
- A {{char}} mention could bring in that character's definitions. Guided Generations existing implies missing core functionality.
- Backgrounds: `__transparent`, `_black`, `_white` named weirdly; `__transparent` odd size and square in the grid; backgrounds part of the theme, on the cascade.
- A session on another device on an earlier message mustn't break; fix the desync.
- Page blur (switching app on a phone) closes character info.
- Live editor: cursor lands a line off / Shift+Home selects to the start of the next line (blank lines render 0px tall, so CodeMirror's line map drifts 2px per blank line; why they're 0px is unknown); the editor is capped at 90vh and scrolls; find and replace UX and find-and-replace presets are bad (user to elaborate).
- Install as fast as possible without losing functionality; updating too. Zero friction for everyone, including browsing cards.
- Budget tracking, management, enforcement (money); maybe a general mechanism to display various things.
- Capability parity with other frontends (Marinara Engine's Noodle, Talemate).
