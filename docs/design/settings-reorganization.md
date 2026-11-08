# Settings: what's wrong with the four drawers

Built from inventories of every control in the four settings drawers (staging 2eb5ef058). Each line here names
real controls; file:line references are in the inventories (kept with the plan).

| Drawer | Controls | Old code involved |
|---|---|---|
| User Settings (`#user-settings-block`, index.html 3797–4617) | 126 | ~2,500 lines (power-user.js mostly) |
| AI Response Configuration | ~165 (43 chat completion, 63 text generation, 6 shared, presets, prompt manager, logit bias, sampler orders) | now the new page's fields; presets etc. still old |
| API Connections (`#rm_api_block`, 1095–2918) | ~200 across 5 APIs, 26 chat completion sources, 15 text generation types | ~5,000 lines over a dozen files |
| AI Response Formatting (`#AdvancedFormatting`, 2923–3584) | ~75 | ~1,400 lines |

About 570 controls. The problems below are what make them unpredictable: you can't tell where a setting is from what
it does.

## 1. One idea, several places

| Idea | Where it lives today |
|---|---|
| System prompt | Formatting → System Prompt (text completion); the chat completion prompt manager's Main Prompt; the card's Main Prompt override, gated by User Settings → Prefer Char. Prompt |
| After-history instructions | Formatting → Post-History Instructions; prompt manager's Post-History Instructions; card override + Prefer Char. Instructions |
| Where the card, persona, scenario and lore go | Formatting → Story String (a template); chat completion's prompt manager markers; plus "Scenario/Personality/World Info format" utility prompts |
| Chat start / example separators | Formatting → Chat Start, Example Separator; chat completion's New Chat / New Group Chat / New Example Chat prompts; prompt manager markers |
| Example messages | Formatting → Skip Example Dialogues Formatting; User Settings → Example Messages Behavior; prompt manager's Chat Examples marker |
| Names in the prompt | Formatting → Include Names + Always add character's name; chat completion → Character Names Behavior (4 options, another object); User Settings → Show {{char}}:/{{user}}: in responses (actually trim output); Relax message trim in Groups; World Info → include names |
| Stop strings | Formatting → Custom Stopping Strings, Names/Separators/Sequences as Stop Strings, Single line, the instruct Stop Sequence; `/stop-strings`; profiles |
| Starting the reply | Formatting → Start Reply With (+ show prefix); Claude's Assistant Prefill and Impersonation Prefill; Continue prefill/postfix; profiles |
| Reasoning | Formatting → Reasoning (parse, show, add to prompts, template); text generation's Request Model Reasoning; chat completion's Request model reasoning, Reasoning Effort, Interleaved Thinking |
| Streaming | three toggles (one per text API) + chat completion's, + User Settings' Smooth Streaming / FPS / fade-in |
| One backend | OpenRouter, KoboldCpp, any OpenAI-compatible server and llama.cpp are each reachable through two API kinds, with separate keys, models and options |
| Sampler parameters | one parameter under several names per API family (`temp_openai`, `temp`, `temperature`), each with its own slider |
| Picking templates automatically | five mechanisms: activation regex, bind instruct to context, Bind Model to Templates, the two derive-from-model bolts; plus bind preset to connection, connection profiles |

## 2. Grouped by API family, not by what it does

- The Formatting drawer is hidden whenever chat completion is selected, but its reply cleanup (trim sentences,
  collapse newlines, trim spaces), custom stop strings, Start Reply With and the whole Reasoning section apply to
  chat completion too: a chat completion user can't reach them.
- AI Response Configuration holds chat completion's prompt formatting (utility prompts, names behavior, continue
  postfix, prefills), which is Formatting's subject for text completion.
- Which sampler panel and which prompt system you see is decided by the first choice in API Connections (text
  completion / chat completion / KoboldAI / NovelAI / Horde), which is how the code is split, not a choice the user
  makes: the user picks a backend.

## 3. Generation settings among the display settings

User Settings holds settings that change what's sent or generated, several labelled as display:
- Show {{char}}: / Show {{user}}: in responses trim the generated text (script.js 5773–5834);
- Prefer Char. Prompt / Instructions, Example Messages Behavior, Request token probabilities, Relax message trim;
- Auto-swipe (4), Auto-Continue (3), "Send" to Continue, Swipes, image overswipe (generates images);
- Relaxed API URLs (connections).

## 4. Mechanisms shown as settings

Values the app should work out, shown as things to set: context size (a fact of the model; the settings model already
calls it derived), Best-match tokenizer, the derive bolts, Bind Model to Templates, Bind to Context, bind preset to
connection, bypass status check (one flag per API family, honoured for a source or two), Relaxed API URLs.

## 5. Bundles holding the wrong things

- The theme holds Lab Mode, Zen Sliders, Tags as Folders, Characters Hotswap, Click to Edit and the message-info
  toggles: switching themes changes how the sampler panel and editing behave. Stream fade-in, smooth streaming,
  autocomplete style and the character list subheader are appearance but aren't in the theme.
- A chat completion preset holds connection settings (applied with "bind to connection") and prompts.
- A context template holds three global switches (always add character's name, trim sentences, single line).

## 6. Hidden or dead

- Advanced Mode hides ~40 settings, among them Enter to Send and Swipes. The mode itself is the owner's: "vastly
  simplify options with advanced mode toggle (defaulting to off)" (2026-09-11T16:42:44). Advanced Formatting shows
  only with text completion and Advanced Mode both: "visibility conditional on text completion AND advanced mode"
  (2026-09-12T01:54:28; `#advanced-formatting-button`, `public/index.html:2917`).
- Dead: Lorebook Import Dialog (hidden, no reader). Near-dead: Relaxed API URLs (KoboldAI Classic only), image
  overswipe (one extension), STRICT_ESCAPING, Log prompts to console.
- Appearance choices with no preview: avatar shape, chat style, media style, notification corner, drawer bar (two),
  list subheader, colours shown only where the drawer covers them, autocomplete style.

## 7. Bugs found on the way (old code, for the record)

- Exporting a theme first overwrites the saved theme with the current settings; importing one doesn't apply it.
- Applying a context template sets always-add-name and trim-sentences with an `input` event their handlers don't
  listen to, and doesn't save them.
- Bind Model to Templates always saves (it tests a promise).

## What the grouping should be

Five places, each about one thing the user does, everything derived from the connection hidden:

| Place | Holds | Replaces |
|---|---|---|
| **Connection**: where requests go | one list of backends (grouped: hosted / local / other); per connection its URL, key, model, and request format where a backend has both; the tokenizer only where it can't be worked out | API Connections' five kinds, per-source model keys, proxies beside it, bypass/relaxed flags, profiles' connection half |
| **Generation**: how the model answers | parameters by their backend name (what the connection takes, from data: label, range); response length; context cap (the context itself is the model's); stop strings (one list); reasoning (request, effort); streaming (one); auto-continue, auto-swipe; reply cleanup (trim, names) | sampler panels per family, the streaming toggles, scattered trims, stop strings in four places |
| **Prompt**: what's sent | a layout (named slots; for text completion the story string and its wrapping, for chat completion the message sequence) filled by entries in books; entries have a slot and when they're active; the system prompt, after-history instructions, utility prompts, Author's Note, character's note, prefill and lore are all entries | the prompt manager, Advanced Formatting's templates and System Prompt, utility prompts, the note panels, Start Reply With, the five auto-pick mechanisms (a layout can say which models it's for) |
| **Appearance**: how it looks | the theme (only visual things), each choice with a tile and a full composed preview | User Settings' first column, minus the non-visual toggles |
| **Behaviour**: how the app works for you | input and editing, chat display, the library, notifications, accessibility; account, extensions and maintenance | the rest of User Settings and its Advanced Mode split |

Presets follow the places: a **generation preset** is a set of parameters; a **prompt preset** is a layout with
books; a **profile** names a connection and the two presets. Settings search is the command palette over all five
places, generated from the same data.

## Levels: the level slider

Each panel has one level range slider over default · preset · you · character · chat ("level. slider.", owner,
2026-10-26T10:58:13):
- The panel shows the settings resolved from the levels inside the range.
- The top handle is where edits go.
- Each field carries a stripe in the color of the level its value comes from: default none, preset green, you blue,
  character orange, chat purple (Okabe–Ito), as theme variables. The slider's positions are labelled, so color is
  never the only cue. Asked "ok what about colors" (10:58:56), the owner answered "sure" (10:59:32) to this scheme.

Built in `packages/areas/settings/page/LevelSlider.tsx`. Where the code differs:
- Levels: `default, preset, user, group, character` (`LEVELS`, `packages/areas/settings/protocol.ts:1639`;
  `LEVEL_POSITIONS`, `src/settings-document.js:29`). There is no chat level, there is a group level between user and
  character, and the label reads "User", not "You" (`LevelSlider.tsx:57`).
- Edits: a write goes to the range's top level only for a bundled field; every other field is written at user level
  whatever the top handle says (`routeOf`, `src/settings-document.js:246-255`). With the top handle on default the
  page disables the fields (`packages/areas/settings/page/fields.tsx:61`) and the server refuses unset, reset, fit
  and neutralize (`packages/areas/settings/server.ts:219-259`), but `settings.set` writes at user level (`:197-217`).
- Panels: one slider exists, in AI Response Configuration (`#settings_levels`, `public/index.html:259`); no other
  panel has one.
- Stripes: only a value from group or character gets one, in `--SmartThemeQuoteColor`; preset and user values get
  none, and a field with no value in the range is dimmed (`public/css/settings-panel.css:5-12`). No Okabe–Ito colors
  and no per-level theme variables exist.
