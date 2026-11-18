# SKILL.md — turning adopted facts into probes

Read this before migrating a `blocks/adopted/*.md` block into a probe. It
defines the division of labor and the verification contract that keeps your
work honest.

## The division of labor

- **You (the agent/LLM) do the one-time semantic translation.** Read the
  hand-written fact, decide which sentences reality can prove, write the shell
  that proves them. This happens once — at *compile time*.
- **The shell you write does the forever job.** Every later `groundfact probe`
  run re-detects reality mechanically. You are not in that loop.

Never generate machine facts at runtime. A fact layer fed by an LLM on every
probe run is non-deterministic (false drift on every run), unauditable, and a
prompt-injection surface into every agent's context. Your job is to retire
yourself: the deliverable is a dumb script.

## Classification guide

For each sentence in the block:

- **Probeable** — a shell command can falsify it today: versions, paths,
  listeners, tool flavors, reachability, file existence. Detect it.
- **Policy** — it prescribes behavior ("always", "prefer", "never",
  "must"): a rule for agents, not a fact about the machine. Keep the words
  (in the probe's output if they belong with the fact, or leave the sentence
  in a user block if it is pure policy).
- **History** — it narrates the past ("previously we used...", "was migrated
  from..."). It is not context; propose deleting it.

## The migration recipe

1. `groundfact migrate <block-id>` creates `probes.d/<block-id>.sh` as a
   **frozen probe**: it `cat`s the adopted text verbatim. That text is your
   **oracle** — the ground truth as the human wrote it. The command also runs
   the probe once, loading the oracle into the machine profile as the
   comparison baseline.
2. Edit the probe: replace the heredoc with real detection. Rules:
   - emit only what changes when reality changes — no timestamps, no
     unordered listings, no hostnames that rotate
   - if the human's sentence is still true, your output must match it
     byte-for-byte; if reality differs, your output must differ in exactly
     the lines that are wrong, nothing else
   - quote the heredoc delimiter so nothing expands
3. Verify against the oracle:
   - `groundfact probe` — the diff it prints is the oracle comparison: old
     text → measured reality. It must be empty if reality still matches the
     empty if reality still matches the human's text. Every differing line
     is either (a) your probe is wrong — fix it, or (b) reality changed —
     say so explicitly, line by line. Never hand-wave a diff away.
   - `groundfact probe --verify` — your probe must be deterministic across
     two back-to-back runs, or it will cry wolf forever.
4. Remove the source of duplication: `rm blocks/adopted/<block-id>.md`,
   then `groundfact build`, then `groundfact check` — it must be green.

## Why the oracle catches hallucination

You cannot claim a fact you did not detect: if your probe emits text that
differs from the hand-written oracle, `probe` shows the diff and a human (or
the loop above) makes you explain it. The hand-written text is the test
fixture; your detection code is the implementation; `groundfact probe` is the
test runner. Write the implementation until the test passes — or until the
test itself is proven stale, out loud.
