# Settings scopes: this tab and this device

An amendment to the settings model (`settings-model.md` §1.1, kept with the backlog in
`~/sillytavern-harness-backup-2026-10-17.tgz` until the settings redesign is built). Built with that redesign.

## Levels

One order for every setting, closest first:

1. **tab**: the tab's server session (`X-ST-Session`, `public/scripts/tab-session.js`, `engine/src/store/sessions.rs`).
   Its statements are stored on the session record, so history already names them.
2. chat
3. character (in a group: the speaking character, then the group)
4. **device**: one browser on one machine, for one user.
5. user
6. default

Bundles, overrides, resolution, edits, history and forgetting work at the new levels exactly as at the others.

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
A reader-bound switch, "ignore chat backgrounds", lets a tab, device or user skip the chat and character levels for
the background.

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
- Compat: `assemble(user, {chat, session, device})` resolves what the tab sees; `power_user` and
  `background_settings` show resolved values. Upstream writes go to the level supplying the value;
  `chat_metadata.custom_background` (upstream's "lock background") is the chat's background statement. An import lands at user level; upstream's localStorage
  language becomes a device-level statement. `AccountStorage` (navigation locks, page sizes) is per-browser UI
  state, not settings, and stays in localStorage.
- Cost: at most 6 levels, so O(levels) point reads per resolved slot; one localStorage read and one header per
  request; one small record per device. Nothing is O(devices) or O(sessions) on a request path.
