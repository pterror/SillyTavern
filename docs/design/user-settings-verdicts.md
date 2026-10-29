# User Settings: a verdict per control

Every control in the User Settings drawer (inventory of staging 55a45f2d9, 126 controls), with what becomes of it.
Verdicts:
- **cut**: goes, with nothing in its place;
- **behaviour**: one behaviour, no setting (the row says which);
- **derived**: worked out from something the app knows;
- **theme**: a value of the theme (visual only), with a preview;
- **at X**: a setting of the thing it acts on, shown there (and found by search);
- **command**: an action in the command registry, pinnable;
- **elsewhere**: belongs to another place (Connection, Generation, Prompt) or to an extension.

## Header
| Control | Verdict |
|---|---|
| Language | keep: at the app (Behaviour); follows the browser's language until set |
| Advanced Mode | cut: nothing is hidden behind a mode once the rest is cut or placed |
| Account, Admin Panel, Logout | commands, at the account |
| Search Settings | becomes the palette's settings search, over every place (Q7) |

## Themes
| Control | Verdict |
|---|---|
| Theme select, save as new, update, delete, import, export | the theme place: a list of themes with tiles; edits mark the theme modified, with revert; import applies; export never saves first (both bugs gone) |

## Appearance (all theme, each with a tile and the full composed preview)
| Control | Verdict |
|---|---|
| Avatars (shape) | theme |
| Chat Style (flat / bubbles / document) | theme |
| Media Style (list / gallery) | theme |
| Notifications (corner) | theme; the preview shows a toast |
| Drawer Bar, Drawer Bar (Mobile) | theme, one value: where the bar goes, by the window's width (no separate mobile value) |
| 10 colour pickers | theme |
| Macro colors | theme (the macro colours are colours like the rest) |
| Chat Width, Chat Width Max | theme, one value: the width cap (the percentage follows from it) |
| Font Scale | theme |
| Blur Strength | theme; 0 is no blur |
| Shadow Width | theme; 0 is no shadow |
| No Blur Effect | cut: Blur Strength 0 |
| No Text Shadows | cut: Shadow Width 0 |
| Reduced Motion | derived: the OS's reduced-motion setting (already read); no app copy |
| Stacked Drawers | cut: with the layout (DR22), panels sit side by side when there's room, by width |
| Force Mobile View | cut (added by this fork, 413560a71): the layout follows the window's width, not a device mode |
| Visual Novel Mode | theme (a chat style beside flat / bubbles / document) |
| Hide Chat Avatars | theme (part of the chat style) |
| Avatar Hover Magnification | cut: the zoomed avatar shows full size |
| Compact Input Area | theme |
| Custom CSS | theme |
| Autocomplete style, font scale, width left/right | theme |

## The message
| Control | Verdict |
|---|---|
| Expand Message Actions | cut: on a pointer, the message's bar shows on hover, as Discord does; on touch, the message's marking menu (touch and flick: left / right previous / next alternative, up bookmark, down edit, the diagonals the next most used; the menu draws only on a pause). Every message command is in its context menu and the palette. No long press ("incredibly slow", 10-29), no tap-then-action |
| Message Timer, Chat Timestamps, Model Icons, Message IDs, Message Token Count, Swipe # for All Messages | at the message: one "show on messages" list (a message's details, each shown or not), set from the message's menu |
| Show <tags> in responses | at the message: how HTML in messages renders is one choice (render it / show it as text) |
| Pin greeting message styles | behaviour: a greeting's styles stay applied (the lazy unload is a bug to fix, not a choice) |
| Media volume, autoplay | very prominent (AU1, "to avoid earblasting"): the default volume and autoplay (off by default) are asked where embedded audio is first met (the first message or card with audio, before it can play), and stay on every player (its volume and autoplay change the default); also in Behaviour |
| Forbid External Media | at the character (it already has a per-character override), with the user's default |
| Smooth Streaming, its speed, Exclude 'Thinking...', Stream Fade-In, Streaming FPS | behaviour: streamed text shows as it arrives, redrawn per frame; the four knobs exist because the old redraw was slow. One choice stays only if it's still needed after measuring |
| # Msg. to Load | behaviour: the chat loads as you scroll (no count to pick) |
| Auto-scroll Chat | behaviour: follows the end while you're at the end, stops when you scroll up |
| Show group chat queue | at the group |

## The input
| Control | Verdict |
|---|---|
| Enter to Send | at the input: Enter sends, Shift+Enter is a new line; a binding in the registry (Q7), rebindable |
| "Send" to Continue | cut: an empty Send doing something else is a hidden overload; Continue is a command, pinned by default |
| Quick "Continue", Quick "Impersonate" | cut: pins (Q7) |
| Restore User Input | behaviour: an unsent draft is always kept, per chat, as a draft |
| Click to Edit | at the message: a binding (click / double-click / none) in the registry |
| Auto-save Message Edits | behaviour: an edit is kept as you type and finished by confirm or leaving; cancel restores |
| Confirm message deletion | behaviour: delete at once with undo (the engine keeps history); no confirmation, no setting |
| Markdown Hotkeys | bindings in the registry |
| Show hotkeys while holding Ctrl | cut (added by this fork, 26bb3ca7b): the registry's cheatsheet, opened by a binding |
| Auto-select Input Text | behaviour: per field, decided by the field (a rename field selects its text; others don't) |
| Gestures | behaviour on touch: the message's marking menu (above); an edge swipe opens the left or right panel. Bindings in the registry, rebindable; no long press |
| Swipes | behaviour: swipes are always there (a single reply shows no arrows until there's a second) |
| Autocomplete visibility, auto-hide, show in all macro fields, matching, keyboard | at the input: one autocomplete with defaults; the palette and slash commands share it (Q7). Matching is fuzzy; keys are bindings |
| STRICT_ESCAPING | cut: a parser flag a script can set for itself |

## The library
| Control | Verdict |
|---|---|
| Char List Subheader | at the list: which detail the list shows under a name, set from the list's menu |
| Show avatar filenames | at the list (another detail in the same choice) |
| Tags as Folders | at the list: a view of the list (flat / by tag folder) |
| Characters Hotswap | cut: favourites as a pin row (Q7) |
| Advanced Character Search | cut: there's one search (the engine's) |
| Faster quoted phrases | behaviour: the server decides its index; no user setting |
| Import Card Tags | at import: asked in the import dialog, with "remember" |
| Never resize avatars | behaviour: the original image is kept, thumbnails are made from it |
| Spoiler Free Mode | at the character: definitions folded until opened, remembered per character |
| Forbid Linked Lorebooks | cut: a Chub card can name lorebooks it doesn't contain, which the server fetches from Chub (`src/endpoints/content-manager.js:464`). They're imported with the card when the site is allowed, by the sites rule (`modules.md`), and kept as links otherwise |
| Always Allow Custom CSS | at the character (already asked per card), with the user's default |
| Keep recently used characters, How many | cut: a cache size is the app's to decide |
| Lorebook Import Dialog | cut: hidden, nothing reads it |

## Generation and the prompt (elsewhere)
| Control | Verdict |
|---|---|
| Prefer Char. Prompt, Prefer Char. Instructions | Prompt: the card's system prompt and after-history instructions are entries in the card's book; levels decide which applies, no switch |
| Example Messages Behavior | Prompt: the examples section's budget (kept / trimmed / dropped), per the budget rule |
| Show {{char}}: in responses, Show {{user}}: in responses | derived: when the prompt format writes "Name:" before turns, a reply's own leading "Char:" is stripped and "\nUser:" is a stop string; when it doesn't, neither applies. Today they trim every backend's output, and an off "Show {{user}}:" deletes a whole reply that starts with "User:" |
| Relax message trim in Groups | derived, the same way (group members' names) |
| Request token probabilities | Generation: a parameter where the backend takes it; the viewer at the message asks for it |
| Auto-swipe (4), Auto-Continue (3) | Generation: rules on a reply (retry when shorter than n or containing words; continue to n tokens) |
| Image Swipe Behavior | elsewhere: the image generation extension's own setting |
| Mad Lab Mode | cut: ranges come from the parameter table and the backend; "no limits" is an edit of a range, not a mode |
| Zen Sliders | cut: one slider design for parameters |
| Log prompts to console | cut: the prompt preview (Q1) and itemization show it |
| Relaxed API URLs | Connection, or cut (only KoboldAI Classic reads it) |

## Other
| Control | Verdict |
|---|---|
| Message Sound, Background Sound Only | at notifications: one choice (sound when a reply finishes: never / when the tab is hidden / always) |
| Auto-load Last Chat | behaviour: the app opens where you left it |
| Reload Chat, Debug Menu, Clean-Up | commands |

## Count
126 controls. In the drawer afterwards: Language, the theme list. Everything else is cut, one behaviour, derived, a
theme value with a preview, at the thing it acts on, a command or binding, or another place's.
