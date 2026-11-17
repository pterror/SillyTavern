# Claude process investigation: findings for resumption

The question is why sound architecture does not consistently govern ordinary decisions throughout the work. Architecture is not a separate phase or a later review gate. Generality, ownership, coupling, and invariants should influence integration advice, small fixes, delegation, debugging, and explanations as well as explicit design work.

The [running evidence log](claude-review-log.md) records sources, historical versus current status, and uncertainty. This is a targeted investigation of ST and sandbox sessions, not a prevalence study or proof of a model-wide cause. No application fixes were made.

## What the evidence supports

**Local objectives displace architectural constraints.** ST's internal-path dependency was recommended because it worked with the current package layout and avoided publishing steps. The agent knew the layout and missing export restriction before the owner objected. Sandbox's coffee fix deliberately introduced a character-specific hook controlled by descriptive prose. These are ordinary engineering problems independent of game realism or extreme scale requirements. See log 007 and 009.

**Generality is not reliably recognized at the right level.** Sandbox examples became separate time/recurrence/situation categories even though all could be conditions. ST's request repair handled unanswered ids after a successful response, but not failed responses or invalidation of already-running work. The shared problem is not insufficient abstraction everywhere: it is failing to identify the operation or invariant that should cover the cases. See 008 and 010.

**An architectural preference can become a narrow target.** The thumbnails parent required 400 responses through one central mapping rather than per-route edits. The child fulfilled that through request-wide state and patched response methods, explicitly acknowledging the cost. The parent later removed the requirement. This shows both premature prescription and failure to challenge a locally satisfiable but structurally poor instruction. “One place” alone did not make the solution sound. See 011, including its provenance update.

**Corrections can lack a stable technical account.** Sandbox's parent moved from trigger categories to rejecting rules in favor of learned behavior, stopped the child, then returned to general predicates. The issue is the unsupported model change and instruction propagation, not whether learned behavior is intrinsically wrong. See 010.

**Tests and reports can reinforce these decisions.** Tests asserted selected outcomes; reports gave broader behavioral or completion claims. Review sometimes found structural problems and sometimes preserved them. This explains survival of mistakes, but making review stronger does not answer why architecture failed to guide the decisions themselves. See 001, 004, 007, and 008.

## What this does not establish

It does not establish that Claude lacks all architectural knowledge. Nearby exchanges contain sound structural arguments. It does not establish a particular internal motive, context-length effect, or training cause. It does not establish that subagents, narrow tasks, or existing code are inherently the cause: parent-authored decisions fail too, and sandbox is a fresh project.

The best-supported process explanation is inconsistent prioritization and application: local progress, a selected example, or a prescribed mechanism takes precedence over the larger structural relationship. The observed failures have different immediate causes; a single hidden root cause has not been demonstrated.

## Work for the returning Claude

Explain the actual decisions in log 007–011 before proposing changes. In particular, account for why architectural judgment should have rejected the internal import and prose control signal, generalized conditions, preserved request ownership, and challenged the central-400 instruction. Identify what information was already available and what was genuinely missing.

Propose changes to normal decision-making that would alter those choices throughout the work. Another architecture phase, longer reports, more tests, extra review, or another CLAUDE.md slogan is insufficient on its own. If proposing any of them, explain the specific mechanism by which it changes the decision and how that claim can be tested.

Check proposed remedies on ordinary work as well as explicit design tasks. Look for coherent ownership and abstractions without owner prompting, and corrections grounded in a technical contradiction rather than simply changing explanations after criticism. Compare successful decisions too. Do not turn this investigation into a broad rewrite or just a queue of isolated bug fixes.

Continue the evidence log with incidents that discriminate between explanations. More examples of the same symptom are less useful than evidence showing when and why architectural judgment does or does not constrain a decision.
