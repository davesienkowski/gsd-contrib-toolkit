# CTK-ADR-0010: Require session-scoped memtrace evidence from tool-recorder's log before a review verdict (ENF-20 step 8a)

- **Status:** Proposed. Dave has not approved this record. It becomes Accepted, or is superseded, only
  by his explicit sign-off; until then it documents a decision implemented on a branch, not an approved
  one.
- **Review:** Published for maintainer review and open to revision. A changed decision will be recorded
  by a superseding or amending CTK-ADR, never by a silent edit to an accepted record.
- **Date:** 2026-10-06 (milestone v2.8).
- **Scope:** GSD Contribution Toolkit.
- **Relates to:** ENF-20 (`hooks/review-artifact.cjs`, new gate entry `R8a-memtrace`), its log reader
  (`hooks/lib/tool-log-reader.cjs`), OBS-01 (`hooks/tool-recorder.cjs`, which now exports the one
  kill-switch definition `isRecorderOff`), and re-review step 8a in
  `skills/maintainer-review-sweep/re-review.md`.
  **Amends [CTK-ADR-0006](CTK-ADR-0006-universal-step-enforcement-and-obligation-scaffolding.md)
  Decision 4**: review-side gating was bounded to four mechanizable steps; it becomes five. Extends the
  trust ladder that [CTK-ADR-0004](CTK-ADR-0004-artifact-gated-step-discipline.md) started and
  CTK-ADR-0006 Consequences named (attestation < artifact < independent verification) with one new
  rung. Cites [CTK-ADR-0005](CTK-ADR-0005-graded-gate-severity-and-toolkit-owned-signals.md) Decision 1
  and 2 (`ask` as a third decision, severity matched to confidence) and
  [CTK-ADR-0007](CTK-ADR-0007-runtime-freshness-and-the-network-unavailable-severity.md) Decision 2 (an
  unobtainable input resolves to `ask`). Provenance: Trek-e's
  `skills-from-the-artificer gsd-core-hooks/hooks/require-memtrace-evidence.sh @4060f2a`. CTK-ADR-0001
  to 0009 are unchanged.

## Context

**What the step asks for.** Re-review step 8a runs memtrace's graph pass beside `/code-review`. Its
"confirmed-available floor" is `get_symbol_context` (role and callers of the changed symbols),
`get_impact` (the blast-radius line) and the recorded-decision check, one of `recall_decision`,
`why_is_this_here` or `governing_contracts`. Until this record, 8a was advisory: ENF-20 gated steps 8,
13, 1 and 10 only, and an approve with no graph pass at all was allowed.

**Trek-e's version.** `require-memtrace-evidence.sh` (cited above by repository, path and commit) gates
`gh pr review` on a `### Memtrace Evidence` section in the review body. It requires that section to
name `get_impact`, `get_symbol_context`, `recall_decision` and `find_code_review_issues`, accepts a
CodeGraph fallback with a `Memtrace unavailable:` line, and exempts `--comment` reviews. A body section
is prose the reviewer writes; it shows that the reviewer typed the tool names, not that the tools ran.

**The brief's tool-set claim, corrected.** The Phase 38 brief said `find_code_review_issues` "does not
exist". It does: the orchestrator's 2026-10-05 check of the live `mcp__memtrace__*` surface lists it.
It is not required here because the toolkit's own canonical procedure (re-review.md 8a) lists it among
the richer, optional verbs, not in the floor. The required set is the floor, and it lives in one place
(`MEMTRACE_REQUIRED_ALL`, `MEMTRACE_REQUIRED_ANY` in the hook), held in step with the skill by a parity
test.

**A better evidence source already exists.** tool-recorder (OBS-01) appends one JSON line per tool call
to `~/.gsd-contrib/tool-log.jsonl` (the directory is overridable with `GSD_CONTRIB_LOG_DIR`, resolved by
the recorder's own `resolveLogDir`). Its scope, recorded honestly:

- The log is user-level and global: every repository and every session on the machine writes to the
  same file, and each row is keyed by `session_id`.
- It rotates once: when the live file passes 50 MiB (`MAX_LOG_BYTES`) the recorder renames it to the
  single slot `tool-log.1.jsonl`, replacing whatever was there.
- By tool-recorder's design rule D2, a row holds `ts`, `session_id`, `tool_use_id`, `tool_name`,
  `outcome` (`ok` or `fail`), `duration_ms` and `cwd`, and never the tool's inputs. The gate's own
  verdict rows (OBS-02, `source: "pretooluse-gate"`, no `outcome`) share the file.

**Measurements taken while planning (2026-10-05, read-only, no log contents printed).** The live log
was 7.06 MB / 26,726 rows, all gate verdict rows with `session_id: null` and no recorder rows: test
suites run without `GSD_CONTRIB_LOG_DIR` had filled it in about 3.5 hours and forced the 2026-10-05
rotation. The rotated slot was 52.4 MB / 191,990 rows, with 124 memtrace rows across 97 session ids. A
full read plus a substring filter took 206 ms for the 52 MB file and 14 ms for the 7 MB file. The
shipped reader (38-02) scanned a synthetic 52 MiB log built with the recorder's own serializer in
about 40 ms.

**Subagent sessions: measured, under the parent's `session_id`.** Measured on 2026-10-06 with Claude
Code 2.1.291: a tool call made inside a subagent fires the configured `PreToolUse` and `PostToolUse`
hooks with a `session_id` equal to the parent session's. The subagent's tool-event payloads add
`agent_id` and `agent_type`, which the parent's tool-event payloads lack (the parent's `SubagentStart`
and `SubagentStop` events do carry them), and their `transcript_path` is the parent's transcript; only
`SubagentStop` carries `agent_transcript_path`, the subagent's own transcript in a `subagents/` folder
under the parent session. tool-recorder keeps `session_id` and drops `agent_id` and `agent_type` (they
are outside its D2 field set), so a subagent's row is indistinguishable from a parent row, and the
shipped reader returned the subagent's rows for the parent's id in a complete read. Four `claude -p`
runs (print mode) were captured with a raw stdin hook beside the real `hooks/tool-recorder.cjs`: two
with a foreground subagent, one with `run_in_background: true`, and one with a foreground subagent that
made one MCP tool call (`mcp__context7__resolve-library-id`). In each of the first three runs all eight
of the subagent's `PreToolUse` and `PostToolUse` events carried the parent's id; in the fourth all ten
did, including the MCP call's pair, and tool-recorder logged the MCP call under the parent's id. A
memtrace verb is an MCP tool call on the same hook path, so a granted subagent's memtrace calls count
for the parent's verdict. Not measured: interactive sessions, `--agent` sessions, nested subagents,
forks and agent teams, and the `PostToolUseFailure` event (no tool call failed in any run); the runs
were one level deep, registered the hooks through `--settings` and project settings rather than the
installed capability, and the MCP call measured was context7, not memtrace. The hooks documentation says a
subagent's tool events fire the same hooks and carry `agent_id` and `agent_type`, but states no
`session_id` for them; the measurement closes that gap. Evidence:
`.planning/quick/261006-jq4-measure-subagent-session-id-in-posttoolu/evidence/`, in the toolkit's local
planning corpus, which is not published. For the forms not measured, the design below must still not
deadlock if one of them logs under another id.

## Decision

1. **Step 8a becomes the fifth mechanizable review step.** CTK-ADR-0006 Decision 4 admitted a review
   step to ENF-20 only when checking it needs no judgement. Step 8a qualifies once its evidence is a
   machine record rather than prose: "did these named tools run, successfully, in this session" is a
   lookup in a file the harness's own hook wrote. Whether the reviewer read the output well stays out
   of scope, as it does for steps 8 and 10. ENF-20 is extended; there is no new hook, no new ENF code
   and no settings change.

2. **Evidence source and filter.** The gate reads `tool-log.jsonl` first, then `tool-log.1.jsonl`, from
   the directory the recorder resolves. A row counts only when its `session_id` strictly equals the
   PreToolUse payload's `session_id` (normalized with the recorder's own `clean()`), it has no `source`
   key, its `outcome` is `ok`, and it carries every other field the recorder always writes (a string
   `ts`, a string-or-null `tool_use_id` and `cwd`, a number-or-null `duration_ms`), so a three-field
   line is not a row; that narrows what a forged line must look like and does not prevent forgery
   (38 review NT-01). Rows are projected to `{tool_name, outcome}` on read; nothing else
   leaves the reader. Lines are prefiltered by a byte needle for speed only; every kept row is
   `JSON.parse`d and compared exactly. The review body is never read for evidence: a
   `### Memtrace Evidence` section counts for nothing.

3. **The required set.** ALL of `mcp__memtrace__get_impact` and `mcp__memtrace__get_symbol_context`,
   plus AT LEAST ONE of `mcp__memtrace__recall_decision`, `mcp__memtrace__why_is_this_here` and
   `mcp__memtrace__governing_contracts`, by exact name. `find_code_review_issues` is not required (see
   Context). A failed call (`outcome: "fail"`) never counts.

4. **Trigger.** The obligation applies to a `pr-review` that carries a verdict: approve (`--approve`,
   gh's short `-a`, REST or JSON `event=APPROVE`) or request-changes (`--request-changes`, `-r`, REST or
   JSON `event=REQUEST_CHANGES`). Short flags count only on a native `gh pr|issue` segment, so curl's
   `-a`/`-r` never classify as verdicts. A `--comment` review (`-c`) and a REST review with no event are
   exempt from 8a, and never read the log; R8 still applies to them exactly as before. Counting `-a`
   closed a pre-existing ENF-20 bypass: before this change `gh pr review <n> -a` was not an approve,
   so step 10 (the exogenous self-check, `R10-exogenous.json`) never applied to it. That fix narrows a
   bypass and widens nothing else; `classify.cjs` and `argv.cjs` are unchanged.
   A JSON request body is decoded with `JSON.parse` before its `event` is matched, so a
   Unicode-escaped `"APPR\u004fVE"` is an approve, as GitHub reads it. On a REST review (`gh api`,
   curl) whose event cannot be read from the command, the segment is an **unresolved verdict** and
   asks, naming the form: an `event=@…` field (`-F event=@file`, `-F event=@-`, `-f event=@…`),
   `--input`, a curl `-d`/`--data`/`--data-binary` (and `--data-ascii`, `--data-urlencode`,
   `--json`) value starting with `@`, curl `-T`/`--upload-file`, an inline JSON body that does not
   parse, or an event or body built by shell expansion. An explicit `COMMENT` event and a body
   with no event stay exempt. The ask is held like any other, so an R8, R1 or chained deny still
   wins (38 review MJ-02).

5. **Missing evidence denies and scaffolds an obligation, never evidence.** When a complete read shows
   the required set short, the gate denies, names every missing tool, and scaffolds
   `.gsd/contrib/pr-<n>-<oid12>/R8a-memtrace.json` (CTK-ADR-0006 Decision 1). The scaffold is the
   sanctioned unavailable escape, not a record of the pass: `head_oid`, `status` and
   `unavailable_reason` arrive as `<<<FILL:...>>>` sentinels, `status: "unavailable"` is never
   pre-filled, and the only constants are `schema: 1` and `pass: "memtrace-unavailable"`. The file is
   read only when the evidence is short in a complete read. A filled, valid attestation (no
   placeholders, `pass` and `status` exact, a non-blank reason, `head_oid` a >= 7-character prefix of
   the live head) turns the deny into an `ask` that quotes the reviewer's reason as unverified. It
   never allows on its own.

6. **The new trust rung.** The ladder becomes attestation < artifact < harness-recorded execution <
   independent verification. Harness-recorded execution sits above an artifact because the row was
   written by the harness's own PostToolUse hook when the tool ran, not authored by the reviewer. It
   sits below independent verification (the R1 treadmill guard reading GitHub's own review list)
   because the log is a user-writable file and its rows carry no inputs. It is **not proof** of
   targeting: it shows the verbs ran in this session, not which symbols they were run on.

7. **The severity map, as shipped.** "Policy" denies are returned `deny()` values that
   `GSD_CONTRIB_OVERRIDE` does not lift. "Thrown" denies are `FailClosed` errors the override can
   rescue with a receipt (HARD-03). An `ask` is a returned decision that the override does not
   answer. The Source column separates what 38-CONTEXT decided from what the planner and executors
   added; every row marked PLANNER ADDITION or PLANNER REFINEMENT is a judgement a reviewer should
   challenge first.

   | Case | Decision | Source |
   |---|---|---|
   | Not a verdict (`--comment`, `-c`, REST review with no event) | 8a does not apply; the log is not read, nothing is scaffolded | CONTEXT (Trek-e parity) |
   | Evidence complete | this obligation passes; the attestation file is never read | CONTEXT |
   | Evidence complete in the readable part of a partial read | passes: evidence that was found is real | PLANNER ADDITION |
   | No usable payload `session_id` (absent, empty, blank, not a string) | ask | CONTEXT Addendum 5 |
   | Recorder off (`GSD_CONTRIB_RECORD=off`, through `isRecorderOff`) | ask | CONTEXT |
   | Both log files absent or unreadable, or zero `ok` rows for the session | ask (cannot observe is not did not run) | CONTEXT |
   | Evidence short and part of the log unread | ask | CONTEXT |
   | A log file over 64 MiB (`MAX_SCAN_BYTES`) | not scanned at all (no tail read); the read is incomplete, so a shortfall asks | PLANNER ADDITION |
   | The 10 s read budget (`READ_BUDGET_MS`) spent | the read stops and is incomplete, so a shortfall asks | PLANNER ADDITION |
   | Rows projected to `tool_name` and `outcome` only | (reader contract; no `cwd`, ids or inputs reach a reason) | PLANNER ADDITION |
   | The live file is read before the rotated one | (read order; a rotation mid-read can only double-read, never skip) | PLANNER REFINEMENT |
   | Short flags `-a` / `-r` count only on a native `gh` segment | (classifier) | PLANNER REFINEMENT |
   | A REST review whose event comes from a file, stdin, an unparseable inline JSON body or a shell expansion | ask (an unresolved verdict, naming the form); any deny still wins | 38 review MJ-02 |
   | A log slot that is not a regular file (a FIFO, socket, device or directory, or a symlink to one) | refused before it is opened; the read is incomplete, so a shortfall asks | 38 review BL-01 |
   | Several verdict segments in one command | one log read per hook call, shared across the segments | 38 review MJ-01 |
   | Evidence short in a complete read, attestation absent | policy deny naming the tools, plus the scaffold | CONTEXT |
   | Attestation with placeholders (including an empty file) | policy deny naming the unfilled fields | CONTEXT |
   | Attestation filled but `pass`, `status` or the reason fails its assertion, or `head_oid` does not match | policy deny with that assertion's instruction | CONTEXT |
   | Attestation filled and valid, evidence still short | ask, quoting at most 300 characters of the reason, control characters and U+2028/U+2029 replaced, bidi controls (U+202A-202E, U+2066-2069) and zero-width characters (U+200B-200F, U+FEFF) removed, labelled unverified; a mismatched `head_oid` is echoed through the same guard, capped at 80 | CONTEXT; the 300-character cap is a PLANNER ADDITION; the bidi, zero-width and `head_oid` cleaning is 38 review NT-02/NT-03 |
   | The attested reason contains the quote delimiters U+00AB / U+00BB | each is replaced with `"`, so attested text cannot close its own quote and append words that read as the gate's | executor addition (38-03) |
   | Malformed attestation JSON, unreadable attestation | thrown deny (override-escapable with a receipt) | CONTEXT (HARD-01) |
   | An artifact (R8, R10, R13, R8a) or `--body-file` that is not a regular file (a FIFO, socket, device or directory, or a symlink to one), or is over the 1 MiB read cap | thrown deny, the same as a malformed artifact; lstat, O_RDONLY\|O_NONBLOCK and fstat mean it is never opened in a way that blocks or read without bound. A symlink to a regular file is read | 38 verifier VF-2 |
   | A FIFO, socket, device or directory (or a symlink to one) at a gate hot-path state file outside ENF-20: the ENF-21 `runtime-stamp.json` and `upstream-tip-cache.json`, the HARD-03 `override-receipts.log`, or an ENF-19 artifact (`.gsd/contrib/<slug>/*.json`) | each path keeps its existing posture: the stamp is a thrown deny (an absent stamp stays unstamped), a cache read is a miss, a cache write is skipped, a refused receipt write makes the override deny, and an ENF-19 artifact is a thrown deny (also over the 1 MiB read cap, which also bounds the gsd-test run `failures.json` ENF-19 reads; a run with roughly a thousand failures would deny for size, a fail-closed over-gate, never an allow). Reads use this record's VF-2 reader, moved to `hooks/lib/regular-file.cjs`; writes go through its `writeRegularFile`, which opens O_WRONLY\|O_CREAT\|O_NONBLOCK and fstats the fd before any truncate or write | W5 (quick 261006-jts) |
   | The reader throws, or returns a value without boolean `complete`, boolean `recorderOff` and array `records` | thrown deny | PLANNER ADDITION (contract check) |
   | An ask held while a later entry or a chained segment denies (R1 treadmill, R13 merge) | the deny wins: deny > thrown > ask > allow | PLANNER ADDITION |

   The bounds are tied together by test: `MAX_SCAN_BYTES` (64 MiB) exceeds the recorder's 50 MiB
   rotation size plus one record, and the log is read at most once per hook call (`gate()` memoizes
   the read per session id, so a chain of verdict segments shares one read; a counting-reader test
   proves it), so one 10 s read budget is the reader's whole share of the 60 s hook timeout in
   `settings.snippet.json`, kept at no more than a third of it. The rest of the timeout is for the
   `gh` lookups, which the read budget does not bound. The bounds are checked by a test, not by a
   throw at require time, because a PreToolUse hook that crashes while loading is not a deny.

### Trek-e provenance and divergences

| Trek-e behaviour | Toolkit behaviour | Why |
|---|---|---|
| Evidence is a `### Memtrace Evidence` section in the review body | Evidence is tool-recorder's log for the session; a body section counts for nothing | A section is the reviewer's own text (attestation); a recorder row is written by the harness when the tool ran |
| Requires `find_code_review_issues` | Not required | The canonical re-review.md 8a lists it as optional; the floor is the required set |
| A CodeGraph fallback section with a `Memtrace unavailable:` line satisfies the gate | No CodeGraph section. The sanctioned fallback is the scaffolded `R8a-memtrace.json` attestation, which asks a human and never allows | An unavailability claim cannot be checked by the gate, so a human decides it |
| Cannot find the evidence: deny | Cannot observe (no session id, recorder off, log unreadable, zero rows, partial read): ask | CTK-ADR-0007 Decision 2; a subagent's calls are logged under the parent `session_id` (measured, see Context), and a subagent form the runs did not cover must still not deadlock reviews |
| `gh pr review` forms only | Also the REST and `gh api` / curl review forms with `event=APPROVE` or `REQUEST_CHANGES`; an event the gate cannot read asks. The routes that classify `other` are a residual (Consequences) | ENF-15 synonym coverage, which ENF-20 already has |
| Exempts `--comment` | Exempts `--comment` from 8a; R8 still applies to it | Parity on 8a; no weakening of R8 |

## Consequences

- **Positive:** a verdict without the graph pass is now stopped at the harness boundary, on evidence
  the reviewer did not write, at a measured cost of tens of milliseconds per verdict.
- **Positive:** the `-a` step-10 bypass is closed as a side effect of classifying verdicts properly.

**Negative / accepted residuals.** Each is recorded so it is not later mistaken for a guarantee.

- **Execution, not targeting.** The evidence is not proof of what was reviewed: it shows the verbs ran
  in this session, not which symbols they were run on, because tool-recorder D2 never records inputs.
- **A deliberately appended log line counts.** The log is user-writable; a well-formed row for the own
  session is accepted. That is the same class of act as authoring an artifact from one's head
  (CTK-ADR-0006 Consequences): deliberate and recorded, not prevented.
- **The record fields became a contract.** OBS-01's `session_id`, `tool_name` and `outcome` are now
  read by a gate; renaming or reshaping them in tool-recorder breaks ENF-20 step 8a.
- **A recorder drop can deny.** If the recorder silently misses a successful memtrace call while the
  session has other rows, the read is complete and short, and the gate denies; the escape is the
  attestation, which asks.
- **`ask` is not a block.** Every ask, including a filled attestation, reduces to allow under
  `--dangerously-skip-permissions` and in any unattended run (the limit CTK-ADR-0005 and CTK-ADR-0007
  record).
- **An ask can be lost to an override.** If an R8a ask is held and a later step in the same call
  throws while `GSD_CONTRIB_OVERRIDE` is set, `runGate` returns allow with a receipt and the ask is
  gone. This is consistent with HARD-03 (the override already bypasses whatever the throwing step
  checks), and the receipt records the bypass.
- **No `ask` proof kind.** `bin/verify-hooks.cjs` proves deny and allow at the real entrypoints only;
  the R8a asks are proven by unit rows in `hooks/review-artifact.test.cjs`.
- **Session-scoped, not head-oid-scoped.** A graph pass run earlier in the same session, for an older
  push of the same PR or for another PR, satisfies the gate; binding evidence to a head oid would need
  the inputs the recorder does not keep.
- **Routes that classify `other` reach no ENF-20 entry (pre-existing, ENF-20-wide).** The shared
  `hooks/lib/classify.cjs` classifies each of these `other`, so R8, R10, R8a and R1 never see them:
  a `gh api graphql` `submitPullRequestReview` mutation; the attached short field
  `gh api …/pulls/<n>/reviews -fevent=APPROVE` (gh's flag parser accepts it); `gh api …/reviews
  --input <file|->` without `-X POST` (with `-X POST` it classifies `pr-review`, and step 8a grades
  it an unresolved verdict that asks); and a review wrapped in `bash -c "gh pr review <n> -a"` or
  `sh -c`. The Phase 38 verifier (VF-1) found seven more wrapper forms that classify `other` and are
  allowed: a subshell `( gh pr review 42 -a )`, a brace group `{ gh pr review 42 -a; }`,
  `nohup gh pr review 42 -a`, `eval "gh pr review 42 -a"`, `echo 42 | xargs gh pr review -a`,
  `$(echo gh) pr review 42 -a`, and `gh -R o/r pr review 42 -a` (gh accepts `-R` before the
  subcommand). GraphQL is one of these routes, not the only one. All predate this record
  (`classify.cjs` and `argv.cjs` are unchanged by Phase 38); closing them is a classifier change for
  a follow-up, not part of step 8a (38 review MJ-03).
  Fixed by quick 261006-jsm: with only Bash rows in the session log, each of these now denies on R8a
  as a recovered `pr-review`: a subshell `( gh pr review 42 -a )`, a brace group, `nohup` (and
  `setsid`, `time` and a `!` negation), `eval`, `xargs` fed by `echo 42`, `gh -R o/r pr review 42 -a`
  and `gh pr -R o/r review 42 -a`, `bash -c` / `sh -c` (and the `-lc` / `-ec` bundles),
  `-fevent=APPROVE` / `-Fevent=APPROVE`, and a GraphQL `submitPullRequestReview` or
  `addPullRequestReview` whose name and event are visible. A bare `--input` on `.../reviews` without
  `-X`, and a visible GraphQL review mutation whose event is unreadable, ask with the MJ-02 UNRESOLVED
  wording. `$(echo gh) pr review 42 -a` is an uncertain route that asks, with no PR lookup (see the
  opaque-ask bullet below). What stays open is listed in the still-open bullet below.
  The quick 261006-jsm review fix round closed the spellings its code review found still allowed:
  `eval -- "gh pr review 42 -a"` and `builtin eval "..."`; gh fields bundled behind `-i`
  (`-if event=APPROVE`, `-iFevent=APPROVE`, `-if query=...`); curl bundles (`curl -sd`, `-sSd`,
  `-sX POST`) on a reviews or GraphQL URL; the full-URL `gh api https://api.github.com/graphql`
  (and `graphql?x`); and a GraphQL event behind a string, a `#` comment, an alias or a second
  mutation, or carried by `input: $var` (bracket fields such as `input[event]=APPROVE`, an
  `input=` JSON value, or curl `variables`). Each now denies on R8a with only Bash rows; an input
  or event variable the gate cannot read asks with the MJ-02 UNRESOLVED wording.
- **Extending the rotated log past the scan cap turns a deny into an ask.** `truncate -s 65M
  tool-log.1.jsonl` sparse-extends the file at once and loses no data. The recorder never writes the
  rotated slot, so every later read skips it as over `MAX_SCAN_BYTES` (64 MiB), the read is
  incomplete, and a real shortfall becomes the cannot-observe ask, which an unattended run allows.
  It gives no capability beyond the accepted forgery residual (an appended row already gets an
  allow), so it is recorded, not fixed (38 review MN-01).
- **A log line with no newline costs quadratic time and memory to skip.** Until a newline is seen,
  the reader's carry buffer grows to the whole file and is concatenated and rescanned per 1 MiB
  chunk: a 63 MiB file with no newline measured 1.2 s and about 300 MB RSS, against 0.09 s and
  112 MB for a healthy 52 MiB log. The size limit bounds it, and with one read per hook call it is
  paid once per call. Dropping a carry longer than a few `MAX_RECORD_BYTES` is a possible later
  hardening (38 review MN-02).
- **Some non-verdicts over-gate.** `gh pr review <n> --approve=false` (gh reads it as not-approve),
  `gh pr review <n> -b "-a"` and `gh pr review <n> --comment -b event=APPROVE` classify as verdicts,
  so R8a and R10 apply though gh submits none. The error only over-gates (an avoidable ask or deny,
  never an allow), so it is recorded, not fixed (38 review NT-05).
- **A FIFO at the live slot no longer blocks the verdict writer: fixed by commits fa629cc and
  3bcc906, quick task 261006-jox.** The reader refuses a non-regular file in either slot (38 review BL-01). Before the
  fix, every gate's verdict row (OBS-02, `verdict-log.cjs` through tool-recorder's `appendRecord`)
  and every recorder row was appended to `tool-log.jsonl` with a blocking open for write, so a FIFO
  planted at the live slot hung every gate before it emitted (measured: still blocked when a 6 s
  probe killed it), and the toolkit's gap backlog (#2a) records that the harness then allowed the
  call. The writer now stats the slot and refuses anything that is not a regular file before any
  open (3bcc906, review WR-01), opens the rest `O_WRONLY|O_APPEND|O_CREAT|O_NONBLOCK|O_NOCTTY`,
  fstats the fd as the backstop for a swapped slot, and rotates only a regular file, so a FIFO,
  device or directory at the live slot drops the log record and does not change the verdict
  (measured: a spawned `gh-issue-create.cjs` with a FIFO at the slot emitted its normal envelope in
  28 ms). A slot swapped to a device between the stat and the open is still opened non-blocking
  before the fstat refuses it, and a hung filesystem can delay any write; neither is a FIFO case. The defect was tracked as `.planning/seeds/SEED-live-tool-log-fifo-hangs-all-gates.md`
  (local planning corpus). The rotated slot, which no writer opens, is the persistent case the
  reader fix closes.
- **Other gate-path file opens are still unguarded (W5 residual).** W5 (quick 261006-jts) hardened only
  the ENF-21 stamp and tip cache, the HARD-03 override receipt and the ENF-19 artifact read (the row
  above). These same-class opens still use a blocking read or open and are unchanged, not fixed: the
  `--body-file` reads in gh-edit, gh-pr-create, gh-issue-create, issue-dedupe and git-commit-convention;
  `hooks/gsd-test-viability.cjs` near line 558, which is stat-checked first but could be swapped after
  the stat; `hooks/worktree-fresh-base.cjs` near line 860, plus its settings read near line 332, which
  is stat-checked first but could be swapped after the stat; gh-pr-create's `readRepoFile` read of
  worktree files; binlib-edit's reads of the worktree `.git` gitdir, commondir and back-pointer files;
  `runtimeDigest`'s reads of the installed runtime tree; `writeStamp` (the runtime-sync CLI, not a
  gate). The off/remove receipt preflight in `bin/contrib-capability.cjs` (a CLI, not a gate) was
  aligned after review (WR-01): it now appends zero bytes through `writeRegularFile`, so it refuses what
  `writeReceipt` refuses before any state is mutated. The tool-log writers are a separate worker's scope (W1). A write through a dangling symlink
  still creates its target, as before, and a dangling symlink at `runtime-stamp.json` still reads as
  unstamped (null, via ENOENT), unchanged from today.
- **A CLEAR-verdict PR comment routes around 8a.** A `gh pr comment` or a POST to
  `/issues/<pr#>/comments` whose body carries `CLEAR` arms R10 (and R1) but not R8a, because R8a is
  scoped to `pr-review` verdicts. It is a route around the memtrace obligation; recorded, not fixed.
  Fixed by quick 261006-jsm: R8a now governs `pr-comment` and `issue-comment` as well as `pr-review`,
  and a `CLEAR` token in a comment body or a `--comment` review body is a step-8a verdict, so with
  only Bash rows such a post denies on R8a. A comment with no `CLEAR` stays outside 8a. The review
  fix round extended this to a top-level REST comment whose body is an attached or bundled field
  (`gh api .../issues/42/comments -fbody=CLEAR`, `-ifbody=CLEAR`, `curl -sd '{"body":"CLEAR"}'
  .../issues/42/comments`), recovered as `issue-comment` / `pr-comment`; a POST with `-X POST` and a
  separate `-f body=...` already classified directly. A comment body read with `--input`,
  and a wrapped comment, stay open (see the still-open bullet).
- **An opaque verdict route asks, it is not denied.** Since quick 261006-jsm a command that may submit
  a verdict through a form the classifier cannot read is an UNCERTAIN verdict route, and the gate
  asks without resolving a PR, scaffolding or reading the tool log. Inside an eval or shell -c payload
  whose command word is an expansion (D7 A), no review hint is required: 17 / 47,642 Bash calls
  (0.04%) in ~/.claude/projects transcripts on 2026-10-06, so `eval "$(ssh-agent -s)"` and
  `eval "$CMD"` ask inside a gsd-core worktree and allow outside one (the gate allows before reading
  anything there). The switch is `OPAQUE_SHELL_PAYLOAD_NEEDS_HINT` (false) in `hooks/lib/classify.cjs`.
  A top-level program built by expansion (D7 B, `$(echo gh) pr review 42 -a`) asks only next to a
  review hint, because 1,509 / 47,642 Bash calls (3.2%) start with an expansion. A payload that does
  not parse, or that nests past `RECOVERY_MAX_DEPTH` (4), asks with no hint (D3); a wrapper stack
  past `MAX_PREFIX_PEELS` (8) asks only with a hint. The grade is `ask`, not deny, because an opaque
  command is not known to be a review (CTK-ADR-0005 Decision 2, CTK-ADR-0007 Decision 2, and the
  MJ-02 unresolved-event ask as the direct precedent).
- **The uncertain and unresolved asks are a prompt only in default mode.** Like every ask, they
  degrade to allow under `--dangerously-skip-permissions` (the mode Dave runs) and in any unattended
  run, so the opaque forms and the file-sourced GraphQL query are a human prompt only in default
  permission mode. The statically recovered forms still deny in every mode when they carry a
  readable event; the recovered REST `--input` form, an unreadable GraphQL input or event
  variable and an unkeyed verdict (see the keying bullet) ask, so they too are a prompt only in
  default mode.
- **A file-sourced GraphQL query asks.** Since quick 261006-jsm a `gh api graphql` (or `/graphql`, or
  curl to api.github.com/graphql) whose query comes from a file or stdin (`-F query=@...`,
  `--input`, curl `-d @...`) asks in a gsd-core worktree with the MJ-02 UNRESOLVED wording, with
  no PR lookup and no review hint required: the request names no PR (a node id would sit in the file),
  and keying R8 to the current branch's PR would turn a possibly read-only query into a deny.
  Measured: 0 genuine such calls in 48,055 Bash calls in ~/.claude/projects transcripts (2026-10-06;
  the 2 regex hits were measurement scripts), against 31 `gh api graphql` calls in total.
- **A `CLEAR` comment is a step-8a verdict.** The Decision table exempts `--comment` from 8a; quick
  261006-jsm narrows that `--comment` exemption to a body without a `CLEAR` token, and extends 8a to
  a PR comment carrying `CLEAR` (re-review step 11 treats `CLEAR` as the verdict),
  without editing the Decision. The cost is one tool-log read per `CLEAR` comment.
- **Verdict routes still open after quick 261006-jsm.** Only a wrapped `gh pr review` is recovered:
  a `gh pr merge`, `gh pr comment`, `gh issue comment` or `gh pr create` wrapped in these forms, or
  written `gh -R o/r pr merge` / `gh -R o/r pr create`, stays `other`. An unclassifiable mutating
  `gh api` synonym inside a wrapped payload is discarded with every other non-review inner result and
  never failed closed (D1). Also open: command substitution `x=$(gh pr review 42 -a)`; `$X 42 -a`
  where X holds "gh pr review"; `dismissPullRequestReview` via GraphQL; a shell script file
  (`bash review.sh`), `bash -s` or a heredoc-fed shell; a `gh pr review` on a later line of
  a multi-line eval or `-c` payload (argv does not split on a newline; pre-existing,
  16 multi-line sh -c calls in 48,055); an attached-field create `gh api .../issues -ftitle=x`; and
  zsh / ksh option parsing,
  unverified locally (zsh is not installed).
  Found by the review fix round and verified to stay `other` and be allowed: shells outside the
  recovered set (`echo 'gh pr review 42 -a' | bash`, `bash <<< 'gh pr review 42 -a'`, `ash -c`,
  `mksh -c`, `busybox sh -c`, `su <user> -c`, `script -c`); compound statements
  (`if true; then gh pr review 42 -a; fi`, and a `for` / `while` ... `do` body), whose verb segment
  starts with a reserved word the walk does not peel; a bundled method on a merge
  (`curl -sX PUT .../pulls/42/merge`, `gh api -iX PUT .../pulls/42/merge`; the recovery reads
  bundles only for reviews and comments); a comment POST whose body is read with `--input`; and a
  wrapped REST comment (`bash -c "gh api .../issues/42/comments -fbody=CLEAR"`).
- **Some recovered verdicts are keyed to the current branch's PR.** A visible GraphQL mutation names
  its PR by node id, and `echo 42 | xargs gh pr review -a` reads its selector from stdin, so the PR
  number cannot be read from the command and the gate keys R8, R10 and R1 to the current branch's
  PR. An approve of a different PR is then checked against the wrong PR's artifacts,
  and it can be allowed when those exist. Since the quick 261006-jsm review fix round (WR-02) the
  gate also holds a fixed ask for every recovered approve, request-changes or `CLEAR` segment with
  no readable PR number (it names the form and echoes nothing), so with complete evidence such a
  command asks instead of allowing;
  any deny still wins, and like every ask it degrades to allow under
  `--dangerously-skip-permissions`. A wrapped review that names no number
  (`bash -c "gh pr review -a"`) asks too, although gh itself reviews the current branch's PR there.
  R8a is session-scoped and unaffected.
- **tool-recorder logs the recovered forms as `pr-review`.** Its action column comes from the same
  classifier, so these forms now log `pr-review` instead of `other`; governed stays false, so this is
  observability, not a gate. `hooks/lib/verdict-log.cjs` records every gate's verdict row with the
  same `classifyAction` action, so those rows say `pr-review` (or `issue-comment` / `pr-comment` for
  a recovered REST comment) for the recovered forms too.
- **Un-isolated test suites pollute the shared log, and their rotation can evict real evidence.**
  Measured: suites run without `GSD_CONTRIB_LOG_DIR` wrote 26,726 gate rows in about 3.5 hours and
  forced a rotation, and the next rotation overwrites `tool-log.1.jsonl` and every recorder row in it.
  `hooks/review-artifact.test.cjs` now isolates itself (an m-07 lock row); other suites that run the
  gates are a residual.
- **Subagent `session_id`: measured one level deep, not for every form.** A subagent's tool calls are
  logged under the parent's `session_id` (measured 2026-10-06 on Claude Code 2.1.291, print mode,
  foreground and `run_in_background`, including one MCP tool call; see Context), so a graph pass a
  granted subagent ran counts for the parent's verdict. tool-recorder drops `agent_id`, so the log
  cannot say which agent ran a verb: the evidence is session-scoped, not agent-scoped. Not measured:
  interactive sessions, `--agent` sessions, nested subagents, forks and agent teams, the
  `PostToolUseFailure` event, and hooks installed through the capability rather than project settings;
  the MCP call measured was context7, not memtrace. If any of these logs under another id, a verdict
  whose graph pass ran there asks or denies, and the attestation escape asks in both cases.
- **The shared ENF-20 override note overstated the valve; corrected.** `OVERRIDE_NOTE`, which the
  other ENF-20 denies carry, said a logged `GSD_CONTRIB_OVERRIDE=<reason>` could get past the deny. For
  a returned policy deny it cannot, because `failclosed.runGateInner` rescues thrown errors only. The
  note now says the override does not lift this deny and names the accountable off switch,
  `node bin/contrib-capability.cjs off --reason "<why>"`. The same correction covers the
  ENF-19, ENF-12 and ENF-11 policy denies, and override semantics are unchanged.
- **Not projected into the bundle.** No skill links this record, so it ships in the repository but not
  in the capability bundle, like CTK-ADR-0008 and 0009.
- **Honesty constraint (inherited):** CTK-ADR-0001's rule applies unchanged. Any blocking property
  belongs to the installed hooks running under Claude Code, not to the toolkit as a thing-in-itself.

## Alternatives considered

- **Trek-e's body section.** Rejected: the reviewer writes it, so it sits on the attestation rung, below
  the artifacts ENF-20 already requires.
- **Record tool inputs to bind evidence to the PR's changed symbols.** Deferred: it conflicts with
  tool-recorder D2 (never record `tool_input`) and needs its own record.
- **Scope evidence to the head oid.** Rejected for now: impossible without inputs, which the recorder
  does not keep.
- **Deny when the log cannot be observed.** Rejected: cannot observe is not did not run (CTK-ADR-0007
  Decision 2). Subagent calls are measured to log under the parent `session_id` (see Context), but a
  form the runs did not cover (the "Not measured" list in Context) could still deadlock every review
  under a deny.
- **Require `find_code_review_issues`.** Rejected: the canonical skill treats it as optional, and the
  gate must not demand more than the procedure it enforces.
- **Read only a tail window of the log.** Rejected: a graph pass early in a long session would fall
  outside the window and be denied falsely. A chunked full scan is measured at about 40 ms.
- **A separate hook with a new ENF code.** Rejected: step 8a is a review step, ENF-20 already owns
  the review verbs, the PR and head-oid keying and the scaffold path; a second hook would need a new
  registration and duplicate all of it.
