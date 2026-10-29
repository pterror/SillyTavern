# Views, the cache, and the bound context

The model for design-agenda B, G and L (build step 1). It generalises what `packages/README.md` ("The shape") and
`alternatives.md` ("Rules checked") already say for the new page to every surface, the old page's included, and adds
the two rules the old page needs: the context bound per chat, and actions as calls.

## State

- **The server owns state; the page draws views of it.** A view is what one surface shows (a chat's window of
  messages, a character's card, a list, counts), under a key, with a version. The page holds the latest version of
  each view it shows and nothing it could compute or that the server stores: no token counts, no matches, no joined
  lists (CH35), no "current character" as a source of truth (agenda B).
- **The page sends actions**: what the user did (`{ type, payload }`), addressed to an explicit target (an entity id
  and the version the user saw), never "the current one". One action is one request. Its answer carries the new views
  of everything it changed that the tab shows; other tabs get them pushed.
- **Newest wins.** An answer and a push may arrive in any order; a view replaces the one held only when its version
  is newer. Correctness never depends on timing: no timer, debounce or poll decides what is shown.
- **Store first, then show** (stored data). A change to a stored chat, card, book or setting is shown when the
  server's answer says it's stored; a refusal shows at the thing (agenda D rule 2) and the page keeps what the user
  typed. Only a temporary chat (no tree) lives on the page alone. There is no page-only fallback for a stored target:
  an action the page can't address (a message with no stored id yet) waits for the id the store gives it, it is never
  applied on the page only.

## What's shown first

- **The last-seen view is shown at once.** The client keeps the views it showed, by key and version, across reloads
  (IndexedDB; memory only where IndexedDB can't be used), the newest few per kind. Opening a surface draws the kept
  view immediately, marked as not yet current where that matters, and the server's answer replaces it. A kept view is
  never used instead of the server's answer, only until it.
- **One request per opening, streamed.** Boot, switching chat and opening a dialog each send one request; its answer
  is NDJSON, what's needed first (the first screen: the chat's last messages, the card's header) then the rest. Each
  part is newer than the one before it.
- **Derived data comes after, pushed.** Token counts, search matches, thumbnails, statistics arrive as later parts or
  pushes, computed by the server once and stored (the count store). Nothing on screen waits for them, and the page
  never asks for them per row.
- **Bounded windows.** No answer grows with the library or a chat's length: lists and chats are windows, more on
  scroll.

## The old page's context and events (extension compat)

- **Each chat has its own array.** Opening a chat makes a new `chat` array (and `chat_metadata` object); the old one
  is left as it was. Code that holds the old one holds the chat it started with.
- **`getContext()` is bound to the chat open when it's called.** Its `chat`, `chatMetadata`, `chatId`, `groupId`,
  `characterId`, `name2` are that chat's, and its chat methods (`saveChat`, `saveMetadata`, `updateChatMetadata`,
  `addOneMessage`, `editMessage`, `appendMessage`, `deleteMessage`…) act on that chat. When that chat is no longer the
  one shown, its reads stay its own, and a write is addressed to that chat on the server (never to whatever is open
  now); a write that needs the page's drawing of it (addOneMessage) does nothing to the screen. This is upstream's own
  rule for `chatMetadata` and `chatId` (taken when `getContext()` is called) extended to the array.
- **A context taken while no chat is open follows the open chat** (its reads are the current chat's), which is what a
  context kept from an extension's start-up saw upstream (one array for every chat).
- **Listeners are notified, not awaited.** The page finishes a switch (draws the chat, takes input) without waiting for
  any listener of `CHAT_CHANGED`, `CHAT_LOADED`, `MESSAGE_RECEIVED`, `CHARACTER_MESSAGE_RENDERED`,
  `ITEMIZED_PROMPTS_LOADED`, `MESSAGE_DELETED`. Listeners still run in their order, each awaited by the next (the
  emitter is unchanged), so an extension sees the same sequence as upstream; a slow one only delays the ones after
  it, never the app. With bound contexts, a listener still running after the user moved on acts on its own chat.
- **A switch is never refused for being busy.** A save in flight, a reply streaming or a field being edited doesn't
  block opening another chat: the save finishes against its own chat, the stream stops or keeps writing its own chat,
  the edit is kept as a draft of its own chat.

## Actions are calls, not synthetic events

- The page's state lives in stores (the server's views, plus the page's own view state such as which row is
  selected), and the DOM is drawn from them, one way. The DOM is never read back as data.
- An action is a function called with its target. Code never runs an action by firing a DOM event at a control
  (`.trigger('click')`, `.click()`, `dispatchEvent(new Event(…))`) or by selecting an option so its `change` handler
  runs. A settings write is an action with its level, never the side effect of an `input` event.
- jQuery `.data()` is not state: a control's value comes from the view it's drawn from.
- Extension compat (upstream's events and exports) is a wrapper outside this flow: when an extension fires `change` on
  an old control, the control's handler calls the action, as it would for the user.

## Kept honest by

- `no-restricted-syntax` bans page-side token counting outside `tokenizers.js` and `st-context.js` (upstream's API),
  with no disable comment left (test `tests/page-rules.test.js`).
- In `packages/`, lint bans `.click()`, `dispatchEvent`, jQuery and `.data()` (there's no jQuery there).
- In `public/`, the count of `.trigger(`, programmatic `.click()` and `.data(` uses per file can only go down
  (`tests/page-rules.test.js` against `tests/page-rules-baseline.json`); each area's port takes its file to zero and
  deletes it.
- e2e: a slow `CHAT_CHANGED` listener (an extension that waits 5 s) doesn't delay the chat being drawn or the input
  taking a message; a context taken in chat A and written after switching to B changes A, not B.
- e2e: switching, boot and opening the alternatives dialog each send one request for their view (counted in the test).
