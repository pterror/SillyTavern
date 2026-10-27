# Modules

Core is a runtime with no roleplay concepts in it. Every feature, character cards and world info included, is a module
registering against a few extension points. Q1 (the prompt builder, `prompt-model.md`) is the first place this applies.

## Core

What stays in core, none of it knowing what a character, a lorebook or a story string is:
- storage (the engine);
- entities and entries; combining conditions (all / any / not, evaluated until stable, which recursive entries need);
- the prompt algorithm: place, budget, render;
- commands, settings and levels;
- the connection interface;
- the page shell.

## Extension points

Each is code. Data (books, entries, presets, the default prompt's sections) is content a module ships, edited like
any other; it needs no extension point.

| Point | Does | Today's features that are one |
|---|---|---|
| provider | makes sections from state | chat history, the card's fields, persona, examples |
| condition type | decides whether an entry is active | keywords (world info scanning), generation type, chance, sticky / cooldown, similarity (vectors) |
| book type | where entries come from, how they're edited | lorebooks, the card's book, the chat's notes |
| format | a file ↔ entities | CCv2/v3 cards, upstream's preset / template / lorebook files, JSONL chats |
| import source | a URL or id → a card and what it links to | the site downloaders in `src/endpoints/content-manager.js` |
| transform | rewrites text at a fixed point (the reply, the prompt, the display) | regex, the reply cleanups (whose defaults become its default rules) |
| command | an action, with what it acts on and when it's available | menu items, buttons, quick replies, slash commands |
| setting schema | what a setting is, its levels, where it shows | every panel's fields |
| backend adapter | a backend's parameters, wire names, request and reply | chat completion sources, text completion types |

Still to specify per point: what it receives and returns, which part runs on the server (state) and which on the page
(an editor), load order, and how a module declares its settings and the sites it contacts. Today's page extension
API keeps working as compat on top.

Kept honest by: core's tests use toy modules, not the roleplay ones; CI starts the app with each module removed in
turn and checks the rest works; a feature that can't be removed, or needs a special case in core, means a missing
extension point.

## Who maintains it, and whether it's on

Two separate questions:
- **Ours** (in this repo, tested here) or someone else's.
- **On in a fresh install** or added later.

| | |
|---|---|
| core | always |
| backend adapters, standard formats (card PNG / JSON, upstream's files, JSONL) | ours, on |
| quick replies, connection profiles, token counts, attaching a file | not modules: commands, profiles, counts at the text, part of a message |
| regex | core's transform point, with today's cleanups as its default rules |
| vectors and the data bank, summarize, gallery, expressions, image generation, captioning, TTS, translate | ours; on as upstream has them for now. The target: installed from a catalogue of official modules (a first-run page offers it), not shipped in every install |
| importers (below) | ours, an extension |
| the character library, and other modules | someone else's |

## Importers

One extension holds the import sources: a generic URL source (a card PNG or JSON at a URL) and one per site (Chub,
JanitorAI, Risu, Pygmalion, AICC, Perchance, and what the character library and STCardsBrowser add). Core only
imports a file, through the formats. Each source declares its site. The character library is a browsing product that
uses the importers.

## Sites the app contacts

Every module that reaches an outside site (import sources, the Hugging Face template fallback, Horde, the extension
list) declares the hosts it may contact, so the app knows them all from the start.
- Fetching public content is allowed without asking.
- When a site can't be reached, the app says so once, with **Try later** (the links stay pending and are fetched next
  time they're needed; later failures are silent, shown on the link) or **Don't contact this site** (off: nothing
  contacts it; its links stay as plain links until it's turned on again, from one of them).
- Settings search finds each site by its host, so it can be turned off before its first failure.
- Sending the user's content (chats, cards, prompts) anywhere is never automatic: only through a connection the user
  set up.

A card's linked lorebooks follow this rule: imported with the card when the site is allowed, attached to the
character as its books ("from Chub"), stored once by the site's id; kept as links otherwise.
