# Settings scopes: this tab and this device

An amendment to the settings model (`settings-model.md` §1.1, kept with the backlog in
`~/sillytavern-harness-backup-2026-10-17.tgz` until the settings redesign is built). Built with that redesign.

## Levels

One order for every setting, closest first:

1. **tab**: the tab's server session (`X-ST-Session`, `public/scripts/tab-session.js`, `engine/src/store/sessions.rs`).
   Its statements are stored on the session record, so history already names them.
2. chat
3. **bookmarks**: the pinned bookmarks above this point in the chat, nearest first (a following bookmark states
   nothing of its own for others; see `state-model.md`).
4. character (in a group: the speaking character, then the group). A card's own statements are the character level.
5. **world**: the world the chat or entry belongs to. Where a setting's subject is an entry or a world, containment
   relations are followed within these levels, as the world names them.
6. **device**: one browser on one machine, for one user.
7. user
8. default: the value when no level states one. Not a level that can be moved or switched off.

Bundles, overrides, resolution, edits, history and forgetting work at the new levels exactly as at the others.

No level for guests or drafts: "multiplayer guests: no such thing", "drafts: tf" (owner, 2026-10-17T03:28:40).

## Which levels a setting may use

Precedence never differs by kind; what a kind may do does (as VS Code restricts settings to scopes rather than
reordering them). Each row of `settings-mapping.tsv` gets a `levels` column.

| Kind | Levels |
|---|---|
| Reader-bound: theme and its fields, font size, chat width, motion and blur, mobile view, input area, movingUI, language | tab, device, user, default |
| Background image | every level |
| Generation: presets, templates, connection, persona, Author's Note, CFG | tab, chat, character, user, default |
| Capabilities run in the browser: TTS voice, speech recognition, WebLLM | the generation levels plus device |

No chat or character can change a reader-bound setting, and output in a shared chat never depends on a device.

The owner on deciding per setting what it's per: "what's per what: incorrect mental model" (2026-10-17T03:28:40).
Whether that rules out this table is not decided. Until it is, the table stays as data: it is each setting's schema
restricting which levels the setting uses (`state-model.md`, "Settings: one cascade along a path"), so it can be
changed or removed without touching the model. World and bookmark levels are not in the rows above yet; which kinds
may use them is open.

## The order is a setting

The owner: "the critical part". The order of the levels is itself a setting, resolved through the cascade like any
other. The shipped order above is its default; it can be stated at any level and per setting (or for every setting
under a name prefix). "On this phone, my settings win over chats" is a device-level statement of the order;
"my preset over characters' presets" is a user-level statement of the order for presets.

Each level in the order can also be switched off while keeping its place. The owner: "ideally with the ability to
toggle some off too i guess but preserve position". The order is a list of levels, each on or off. A level that is
off is skipped when resolving; switching it on returns it to the same position, because the toggle never edits the
list. A toggle is a statement like any other: kept in history, undoable, and overridable at a more specific level
("on this phone, chat-level presets are off"). The order and the toggles are shown, edited, kept in history and reset
like every other value.

Which order resolves the order itself: the owner has not decided. The model's answer, a proposal, is that the order
and the toggles resolve along the shipped order, fixed: they are read at every level, and no statement can switch off
the level that holds it. There is no more general answer here: a statable order of the order has to be resolved
before it is known. Worked example, with real JSON and Lua: `state-model.md`.

## Device

- Identity: a random UUID in localStorage (`st:device`), shared by the users of that browser, sent with each request.
  No fingerprinting.
- Record: keyed `<user>:<uuid>`, holding a name (suggested from the browser, editable), mobile or desktop as last
  seen, and when it was last seen; created when the user first states something at device level.
- An unknown UUID (storage cleared, a private window, another browser) loses nothing on the server. If the user has
  device records, a non-blocking prompt offers "use the settings of [device, last seen …] / new device / no";
  choosing one makes this browser use that record's UUID.
- All tabs of a device share its statements live, through the changes stream.
- User settings list the devices: rename, delete, restore (a delete is a change in history).

## Tab statements and session takeover

Tab-level statements stay with the session when a fresh tab takes it over (even on another device), as its chat
position does. The tab shows what it states ("this tab: preset X") with a reset.

## Fit

- The level picker gains "this tab" and "this device (name)" and hides levels a setting doesn't allow. An edit goes
  to the level supplying the value, so after one "this device only" later edits stay on the device.
- movingUI: the user's desktop and mobile layouts stay the user-level value; a device or tab may name its own layout.
  "movingui saved on device: data loss risk" (owner, 2026-10-17T03:28:40).
- Import: an import lands at user level; upstream's `chat_metadata.custom_background` ("lock background") becomes the
  chat's background statement; upstream's localStorage language becomes a device-level statement.
- Cost: at most 8 levels, so O(levels) point reads per resolved slot, plus the reads of the order and its toggles; one localStorage read and one header per
  request; one small record per device. Nothing is O(devices) or O(sessions) on a request path.
