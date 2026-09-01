# Retiring the diff-based tree save

Tracking stub, not the investigation itself. Written up after a live debugging session (2026-09-01/02)
traced a real data-loss bug back to this exact mechanism (see the commit this stub ships alongside:
`fix(swipes): stop overswipe-regenerate from overwriting the old alternative`). Two targeted fixes from
that session (a `saveMetadata()` fast path, and re-snapshotting after `printMessages()`) patch specific
symptoms of the problem described here; this doc is the placeholder for actually retiring the mechanism
itself. Required to happen, not optional, not something to let quietly drop.

## The problem, in `_saveTreeChat()`'s own words

`public/script.js`, `_saveTreeChat()`'s doc comment already says this plainly:

> It has no idea what the user did. It walks the conversation, asks of each message "is this the same
> object the last snapshot held," and turns every answer of no into an edit... What is wrong is
> deriving which one happened instead of being told. The client knows at the time: a message was
> typed, an edit was confirmed, a swipe was chosen. Every caller here has already thrown that away by
> the time it asks for a save. Untangling that reaches past this function - roughly fifty callers ask
> for a save with no operation attached, extensions among them, through a context API whose whole
> contract is "I changed `chat`, please persist it".

Reference-equality-against-a-snapshot is a guess, standing in for information the code actually had in
hand at the moment the change happened and discarded. Every bug this session traced back to this same
root shape: something replaces a message object for a reason that isn't an edit (filling in swipe
shape, syncing a swipe slot, recording a learned id, moving to a different alternative), the snapshot
comparison can't tell that apart from an actual edit, and the diff engine either does needless writes
(the write-amplification bugs) or - the sharp end, what this session actually broke on - draws the
wrong conclusion (an existing-row edit instead of a new-alternative-create) and silently overwrites
data that was never supposed to be touchable.

## Why patching read-timing (this session's fixes) isn't enough

Both fixes shipped alongside this doc work by making the *snapshot* line up better with what the diff
engine expects - correct, but they're still guessing-avoidance patches on the same fundamentally
guess-based mechanism. Any future code path that replaces a message object for a non-edit reason,
anywhere in the ~50-caller surface the doc comment names, can reintroduce the same class of bug through
a different door. The fix that actually closes this off is the one the code comment already names:
callers state the operation, instead of the save function reconstructing it after the fact from a diff.

## Scope of the actual work (not done here)

1. Enumerate the ~50 callers of `saveChatConditional()`/`saveChat()` (extensions included) and
   classify what each one is actually doing when it asks for a save - typed a message, confirmed an
   edit, swiped, deleted, imported, nothing (a bare "sync everything" call with no event behind it).
2. Design the explicit-operation surface these callers should call instead - the named operations
   already exist for the tree-backed internal call sites (`chatOpEdit`, `chatOpAddAlternative`,
   `chatOpSelect`, `chatOpAppend`, `chatOpEndPath`, `chatOpEditMany`) per `_saveTreeChat`'s own comment;
   the gap is that most callers, especially extensions, don't have anything named to call and fall back
   to "mutate `chat`, then ask for an undifferentiated save."
3. Work out what happens to `_saveTreeChat()`'s diff loop once every *internal* caller has been moved
   onto named operations - whether it can shrink to a true fallback-only path (for external
   extensions that still can't state an operation) or gets removed once that fallback is proven safe
   enough to keep indefinitely for extensions specifically.
4. Migrate callers in batches, verifying each batch doesn't reintroduce the "guessed wrong" failure
   mode this session found - the failure mode is specifically dangerous (silent data loss, not a
   thrown error), so this needs deliberate test coverage per batch, not a single sweeping rewrite.

Not scoped here: whether extensions need a stable "please just save whatever changed" escape hatch
long-term, or whether the migration can eventually close that off too. That's a real open question the
full investigation needs to answer, not assumed either way by this stub.
