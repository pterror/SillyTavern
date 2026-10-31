# Rules

## Architecture
- The page sends only user actions; the server sends state updates. The page may keep state by applying the updates
  it receives.
- One user action is one request. Whatever the server has to supply for it (token ids, token counts, ...) comes back
  in that response, never in a separate request.
- Minimize round trips.
- Every piece of state has one source of truth.
- Make wrong states impossible by construction instead of detecting or repairing them.
- The server is never in a broken state: no stored data is ever missing, partial or waiting for a backfill.

## Scale and storage
- Everything must work at 10 billion cards: no cost per card or per row in any operation, and no read of the whole
  library or a whole table.
- Storage minimizes asymptotic latency, writes and disk space: nothing is stored, derived or written unless a read
  needs it.
- No write amplification.
- The only migrations are from upstream SillyTavern's data. Our own format changes are hard cutovers while there are
  no users: no transition period, no side-by-side rebuild.

## Compat
- Extensions written for upstream are not supported.
- Parity with upstream means reading its data and formats, not copying its behaviour, least of all where it is wrong.

## UX
- The UI is designed from first principles to be best in class; nothing in it ships without the owner's approval.
- Behaviour is as intuitive as possible; "upstream does it" is not a reason.
- Every name is clear and unambiguous to a layperson.
- Sending a message takes under 200ms, also over a VPN or 3G.
- No layout shift.

## Work
- Change the design that causes a problem, not its symptom. A fix to one instance that leaves the others, or a fix
  after the fact, is not acceptable.
- No work without a full mental model of the code it touches.
- New code is written from the requirements, not ported bug for bug; don't spend effort recording old behaviour.
- Old code left in place next to new code is the biggest risk.
- Reason about performance where it can be reasoned; measure only what can't.

## Agents and context
- Work that would poison further thinking doesn't happen in the main context, implementation included.
- Subagents split work; they are not for shedding stale context. Fork to skip re-reading context; a fresh agent pays
  to rediscover it.
- One task at a time, no parallel agents; decomposing a task is fine.
- Give complete answers and complete questions at once, never piece by piece.

## Asking and stopping
- Keep going until there is real ambiguity.
- Make the decisions that can be made from the code and these rules; only bring the owner the ones that are theirs.
