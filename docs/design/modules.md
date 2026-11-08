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
| input handler | handles a kind of input: a file type, or a URL pattern; and exports back to a file type | card files (PNG, JSON, CHARX, YAML), BYAF, upstream's preset / template / lorebook files, JSONL chats |
| transform | rewrites text at a fixed point (the reply, the prompt, the display) | regex, the reply cleanups (whose defaults become its default rules) |
| command | an action, with what it acts on and when it's available | menu items, buttons, quick replies, slash commands |
| setting schema | what a setting is, its levels, where it shows | every panel's fields |
| backend adapter | a backend's parameters, wire names, request and reply | chat completion sources, text completion types |

Pasting a link, dropping a file and "Import" are one lookup: whoever handles that input.

Still to specify per point: what it receives and returns, which part runs on the server (state) and which on the page
(an editor), and load order. There is no compat with upstream's extension API: classic extensions, built-in and
third-party, are removed, and a feature from one comes back only as a module.

## Capabilities

A module gets only the abilities it's handed (object capabilities), never ambient access:
- **network**: a fetch that reaches the hosts it declared and nothing else;
- **writes**: e.g. an import handler gets "create a character from this card", "store these files as its assets",
  "attach these books to it", and can't touch chats or settings; a transform gets the text it rewrites;
- the same for every module (TTS: audio out plus its service's hosts).

Installing a third-party module shows what it can do, because that's all it holds. This is also the model for
sandboxed per-card scripting (EX2).

## Modules and packages

- A **module** is the unit of capabilities and of on / off.
- A **package** is the unit of distribution (one download, one version), holding one or more modules.
- Two things are one module when they always change together and you'd never want one without the other; otherwise
  separate modules, possibly in one package.

| Package | Modules |
|---|---|
| character cards | one: PNG, JSON, CHARX, YAML (one spec, V2 / V3, in different containers) |
| Backyard | BYAF |
| lorebooks | upstream's, Novel's, Agnai's lorebook files |

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
| vectors and the data bank, summarize, gallery, expressions, image generation, captioning, TTS, translate | removed with the extension system (`bf10b5d54`). The target: installed from a catalogue of official modules (a first-run page offers it), not shipped in every install |
| the character library, and other modules | someone else's |

## Importing from sites

The site downloaders are in `src/endpoints/content-manager.js`. Whether they become modules, input handlers or an
interface of their own is not decided: "idk if there should be an 'import source' interface" (owner,
2026-10-27T03:26:06).

## Sites the app contacts

Not decided. The owner on the rule proposed for it: "sounds arbitrary" (2026-10-27T02:13:42), "defer vs disable?" and
"why" (02:21:41).

## A card's lorebooks

- Embedded: "also ideally embedded lorebook (if present) should also stay as standalone embedded" (owner,
  2026-09-12T14:14:35).
- Linked: "objectively linked lbs should be separate otherwise they wouldn't be fucking linked" (owner,
  2026-09-13T00:24:55).
