# Views, the cache, and the bound context

The model for design-agenda B, G and L (build step 1). Every rule names what it follows from: the user's words (the
repo `CLAUDE.md`, quoted, or a dated quote from the agenda's sources) or code and contracts (file:line). A rule with
neither isn't here. `packages/README.md` ("The shape") already holds most of these for the new page; this extends them
to the old page.

Upstream references are to the checkout of upstream staging `ad29cbda6`.

## State

1. **The server owns state; the page draws views of it.** A view is what one surface shows, under a key, with a
   version. The page keeps the latest version of each view it shows, and nothing it could compute or that the server
   stores (no token counts, no matches, no joined lists).
   From: "client sends user actions only / server sends state updates"; "code to maintain client state is fine too,
   i.e. applying the state updates the server sends back"; "ssot everywhere"; "if it needs fucking token ids or token
   counts, then the server fucking returns them" (CLAUDE.md).
2. **The page sends actions addressed to an explicit target** (an id, and the version the user saw), never "the
   current one", and one action is one request whose answer carries the views it changed.
   From: "1 action = 1 request"; "minimize round trips full stop" (CLAUDE.md). The explicit target, from the code:
   "Create new" leaves `this_avatar` set, so More… "Replace / Update" in create mode overwrites the previously opened
   character (agenda B, Inv-CM bug 2).
3. **Newest wins by version, whatever order answers and pushes arrive in.** No timer, debounce or poll decides what is
   shown.
   From: "make them impossible by construction" (CLAUDE.md): an order-dependent result is a race left possible.
   Already the new page's rule (`packages/page/src/client.ts:96`, "An answer and a push can cross: the newer wins").
4. **Stored data is stored first, then shown; a refusal shows at the thing.** A temporary chat (no tree) is the only
   data that lives on the page alone. An action on a stored target the page can't address yet waits for the id; it is
   never applied on the page only.
   From: "how dare the server EXIST in a broken state, EVER"; "ssot everywhere" (CLAUDE.md); "data loss on page reload
   in general = not ideal" (user 09-29). The code it rules out: `/addswipe` on message 0 changes only the page, with no
   request, and is lost on reload (`chatOpAddAlternative` returns null without a request for an unstored node, agenda
   D, found 10-29).

## What's shown first

5. **The last-seen view is shown at once, then replaced by the server's answer**, never used instead of it. Kept by
   key and version across reloads (IndexedDB; memory where it can't be used).
   From: "weren't we supposed to have cached state on the client despite thin client (stale while revalidate?)" (user
   10-29); "consider sending a message should have <200ms latency over vpn and 3g" (CLAUDE.md): a round trip over 3G
   alone exceeds that, so the first paint can't wait for one.
6. **Opening something is one request, streamed**: boot, switching chat and opening a dialog each send one, answered
   as NDJSON, what's needed first, then the rest, each part newer than the one before.
   From: "1 action = 1 request"; "minimize round trips full stop" (CLAUDE.md); "paginating the picker's fetch is that
   not really bad for latency? why not some kind of streaming" (user 10-29). Boot today is a serial chain of about 26
   requests (`public/script.js` `firstLoadInit`, measured 10-29, agenda G).
7. **Derived data comes after, from the server, never asked for per row.** Token counts, matches and thumbnails
   arrive as later parts or pushes; nothing on screen waits for them.
   From: "if it needs fucking token ids or token counts, then the server fucking returns them"; "any per row cost at
   all is unacceptable" (CLAUDE.md). The code it rules out: the swipe picker sent one count request per row and drew
   only after all 50 answered (30 s+ on a phone, agenda G).
8. **No answer grows with the library or a chat's length**: lists and chats are windows.
   From: "the entire architecture MUST scale to 10 billion cards"; "any per row cost at all is unacceptable"
   (CLAUDE.md).

## The old page's context and events

9. **Each chat has its own `chat` array.** Opening a chat makes a new array; the previous one is left as it was.
   **`getContext()` is bound to the chat open when it's called**: its `chat` is that chat's array, as its
   `chatMetadata` and `chatId` already are, and its chat methods act on that chat.
   From: "all extensions must still work"; "compat: breaks are unacceptable" (CLAUDE.md), and upstream's own contract:
   upstream's `getContext()` (`public/scripts/st-context.js:115-135`) takes `chatId` (`:125`) and `chatMetadata`
   (`:135`, the `chat_metadata` object, which upstream replaces with a new one on every chat change:
   `public/script.js:7657`, `:7663`, `:10928`) when it's called. A context an extension keeps across a chat change is
   therefore already stale in upstream for those fields, and extensions must already call `getContext()` again after
   one. Only `chat` stayed live, because upstream refills one array in place (`public/script.js:7658`, `:7662`,
   `:10927`). Binding `chat` the same way extends the existing contract rather than adding one, and it is what makes a
   listener that awaits safe (rule 11): its writes land in its own chat, not in whichever chat is open by then.
10. **A context taken while no chat is open follows the open chat.** Its reads are the current chat's.
    From: "all extensions must still work" (CLAUDE.md): an extension that takes a context once at start-up (before any
    chat is open) relied on upstream's single array, and keeps working.
11. **Chat events are notified, not awaited, by the switch.** The page finishes a switch (draws the chat, takes input)
    without waiting for any listener; listeners still run in order, each awaited by the next (the emitter is
    unchanged), so an extension sees upstream's sequence.
    From: "consider sending a message should have <200ms latency over vpn and 3g" (CLAUDE.md); "measuring tells you
    NOTHING because what if something's fucking blocking the switch" (user 10-29). The code: upstream's
    `EventEmitter.emit` awaits each listener in turn (`public/lib/eventemitter.js:146`) and the switch awaits the emit
    (`public/script.js:7700`), so any listener's I/O holds the switch. Safe without races only with rule 9.

## Actions are calls, not synthetic events

12. **An action is a function called with its target.** Code never runs an action by firing a DOM event at a control
    (`.trigger('click')`, `.click()`, `dispatchEvent(new Event(…))`), and a settings write is never the side effect of
    an `input` or `change` event.
    From: "make them impossible by construction" (CLAUDE.md). The code: applying a chat's settings in place re-fires
    the panels' input handlers, which save them as the user's (ST1 step 11 design, 10-26); Reasoning Cancel triggers
    `.mes_reasoning_edit_cancel:visible`, which is itself (agenda L, Inv-MB bug 8).
13. **jQuery `.data()` and the DOM are not state**: a control's value comes from the view it's drawn from.
    From: "ssot everywhere" (CLAUDE.md): a value kept on an element is a second copy. The code: a character's lorebook
    link is kept as `.data()` on an `<option>` that is then selected by its translated text (agenda L, Inv-CM).
14. Extension compat (upstream's events and exports) wraps this flow and is not part of it: when an extension fires
    `change` on an old control, the control's handler calls the action, as it would for the user.
    From: "all extensions must still work" (CLAUDE.md).

## Kept honest by

From: "never call a task done while any item it listed is untouched; enforce any rule the user gives with a lint rule
or test" (global CLAUDE.md).
- Rule 7: `no-restricted-syntax` bans page-side token counting outside `tokenizers.js` and `st-context.js`
  (upstream's API), and `tests/page-rules.test.js` fails on any call site let through.
- Rules 12-13: in `packages/`, lint bans `.click()`, `dispatchEvent` and `requestSubmit` (`st/no-synthetic-events`;
  jQuery is already banned there). In `public/`, `tests/page-rules.test.js` fails when a file's count of `.trigger(`,
  bare `.click()`, `dispatchEvent(new …Event(` or `.data(` goes up (`tests/page-rules-baseline.json`); each area's
  port takes its file to zero.
- Rules 9-11: e2e: a listener that waits 5 s doesn't delay the chat being drawn or a message being sent; a context
  taken in chat A and written after switching to B changes A, not B.
- Rules 5-6: e2e: switching, boot and opening the alternatives dialog each send one request for their view.
