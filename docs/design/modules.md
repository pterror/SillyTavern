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
| input handler | handles a kind of input: a file type, or a URL pattern; and exports back to a file type | card files (PNG, JSON, CHARX, YAML), BYAF, upstream's preset / template / lorebook files, JSONL chats; the site downloaders in `src/endpoints/content-manager.js` |
| transform | rewrites text at a fixed point (the reply, the prompt, the display) | regex, the reply cleanups (whose defaults become its default rules) |
| command | an action, with what it acts on and when it's available | menu items, buttons, quick replies, slash commands |
| setting schema | what a setting is, its levels, where it shows | every panel's fields |
| backend adapter | a backend's parameters, wire names, request and reply | chat completion sources, text completion types |

Pasting a link, dropping a file and "Import" are one lookup: whoever handles that input.

Still to specify per point: what it receives and returns, which part runs on the server (state) and which on the page
(an editor), and load order. Today's page extension API keeps working as compat on top.

## Capabilities

A module gets only the abilities it's handed (object capabilities), never ambient access:
- **network**: a fetch that reaches the hosts it declared and nothing else. A site turned off (the sites rule below) is
  a capability no longer handed out, so the rule is enforced, not just declared;
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
| importers | one per site: Chub, JannyAI (also takes janitorai.com links, looked up on the mirror), RisuRealm, Pygmalion, AICC, Perchance, a generic URL; more from the character library and STCardsBrowser inventories |
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
| vectors and the data bank, summarize, gallery, expressions, image generation, captioning, TTS, translate | ours; on as upstream has them for now. The target: installed from a catalogue of official modules (a first-run page offers it), not shipped in every install |
| importers (below) | ours, an extension |
| the character library, and other modules | someone else's |

## Importers

The importers package moves the site downloaders out of `src/endpoints/content-manager.js`, once input handlers and
capabilities are specified; on by default, so the move isn't noticed. Each site module returns the card as the site
has it (never flattened to V2), runs on the server (no public CORS relays), and gets fetch to its own hosts only.
Update checks (is there a newer version, what changed) belong to the package, not to each site. Not ported: getting
at definitions a creator hid. The character library is someone else's package that uses the importers.

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
