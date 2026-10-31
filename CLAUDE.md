# Rules (the user's words, verbatim)

## Architecture
- "client sends user actions only / server sends state updates"
- "to be clear, code to maintain client state is fine too, i.e. applying the state updates the server sends back for example"
- "1 action = 1 request"
- "minimize round trips full stop"
- "if it needs fucking token ids or token counts, then the server fucking returns them"
- "ssot everywhere"
- "make them impossible by construction"
- "how dare the server EXIST in a broken state, EVER"

## Scale and storage
- "the entire architecture MUST scale to 10 billion cards"
- "any per row cost at all is unacceptable"
- "we want ssot + minimum asymptotic latency + minimum asymptotic writes + minimum asymptotic disk space"
- "do you understand that it's unacceptable if we have write amplification again"
- "while there are no users, migrations should be hard cutovers"
- "remember we only support migrations from upstream"

## Compat
- "our upstream parity requirement is compat not behavior, especially wrong behavior"

## UX
- "i want a best-in-class ui reasoned from first principles"
- "behavior should be maximally intuitive"
- "ideally all names should be clear and unambiguous to a layperson no?"
- "consider sending a message should have <200ms latency over vpn and 3g (for example)"
- "any other option causes layout shift which is bad"

## Work
- "stop fucking making bandaids"
- "posthoc fixes is unacceptable since it means context and architecture are already poisoned"
- "when i say something and you go off and fucking poison the codebase by fixing one specific thing leaving everything fucking else unfixed"
- "i don't understand why you think it's acceptable to do any work on any project without a full mental model."
- "waste of quota + bug for bug repro is idiotic"
- "any old is the biggest risk"
- "why are we wasting so much time measuring approaches that can be reasoned through perf wise"

## Agents and context
- "please dont poison main context" / "why the hell are you impling in main context?"
- "why parallel/in worktrees at all"
- "ui/ux backlog first. i think all the various stuff in sequence, no parallelism (but decomposing tasks is fine)"
- "subagents are (typically) for splitting work not for dropping context thats no longer relevant"
- "use forking liberally to skip re-reading context"
- "WHY THE HELL DO YOU KEEP DRIPFEEDING"

## Asking and stopping
- "keep going? hello? don't stop until there's actually ambiguity????"
- "you understand that if i wanted to make all the decisions it'd be faster and less friction for me to do it by hand?"
