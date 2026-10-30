# Backlog

Not yet merged in: the lists in `.plans/2026-10-03-backlog.md` inside `~/sillytavern-harness-backup-2026-10-17.tgz` (sections 1-9, the 10-12 and 10-16 pasted lists). Unknown which of those are still open.

- The whole app's UX, from first principles: fewer settings, settings next to what they act on; one consistent UI (prior art: ~/git/lee-app, ~/git/cyoa, ~/git/pteraworld/src/games); too many affordances, gestures replace controls.
- Clipping stays optional; occlusion must be impossible for any overlay to miss (the typing indicator extension doesn't clip the chat).
- Touch: swipe gestures and swipe menus; the swipe picker trigger is too small on phones; swiping to change the character management page doesn't work.
- Greeting and swipe alternatives: an edited greeting keeps its place; duplicates follow their origin; not getting lost among 10-100 edits; re-parenting. Jump to a swipe / show a greeting in the chat, in the modal and outside it.
- Search: filter pills; keyboard use; `"a b c"` vs `name:"a b c"`; repeated searches cached (LRU).
- Startup steps not needed, let alone in series; a service worker. Switching character sometimes takes very long.
- Tests simulating packet loss, slow connections, high latency.
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
