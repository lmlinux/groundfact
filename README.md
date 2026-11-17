# groundfact

**An upstream facts compiler for agent context** — frees your machine environment, cross-project principles, and project conventions from the N hand-maintained copies of AGENTS.md / CLAUDE.md: probes auto-generate a machine profile, hand-written blocks assemble per target and per project trait, and drift is detectable.

```
probes.d/*.sh ──probe──▶ facts/machine.md (machine profile, probed — never hand-written)
blocks/user/*.md         (hand-written: principles that hold across projects)
blocks/project/*.md      (hand-written: project conventions behind when-conditions)
        │
        └──build──▶ ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md, ~/.gemini/GEMINI.md,
                    ~/.pi/agent/AGENTS.md, <project>/AGENTS.md,
                    or .rulesync/rules/ (fan out to 30+ targets via rulesync)
```

## Why not another rulesync

The sync/fan-out layer is already mature (rulesync: 30+ targets, import/convert, global mode). groundfact does not fight for that layer — it sits upstream:

| gap | groundfact's answer |
|---|---|
| machine facts are hand-written and go stale the moment the machine changes | `probe`: idempotent probes (proxy egress, toolchain flavors, ports in use…), diffed against the previous run to report environment changes |
| conditional assembly is file-glob only (most targets ignore it) | frontmatter `when: ["pyproject.toml"]` is evaluated at **compile time** against project traits, effective for every target |
| generation is one-way; hand edits drift silently | `check`: three-way comparison that tells **hand-edit drift** apart from **stale sources**, line-level diff, exit code 1 for CI/hooks |
| fear of clobbering hand-written files | only files with the `groundfact:generated` header are managed; existing hand-written files are skipped by default; `--force` adopts them (with a `.groundfact-orig` backup) |
| adopting years of hand-written facts feels like a rewrite | `adopt` splits at headings and stores sections verbatim — the fact/principle reclassification can happen one section at a time, years later if ever |

## Quick start

```bash
node bin/groundfact.mjs init       # initialize ~/.groundfact (sample probes and blocks included)
groundfact probe                   # generate the machine profile; diff reports changes
groundfact probe --verify          # run probes twice; flag non-deterministic output
groundfact adopt <file>            # mechanically adopt a hand-written file (no LLM)
groundfact migrate <block-id>      # turn an adopted block into a probe (frozen echo = oracle; see SKILL.md)
groundfact build                   # global assembly → the agent files configured in groundfact.json
groundfact build --project /path   # project assembly: when-matched project blocks → /path/AGENTS.md
groundfact build --rulesync /path  # emit rulesync sources (/path/rules/*.md)
groundfact list                    # preview which blocks land in each target
groundfact check                   # drift detection (✓/△/✗; exit code 1 on drift)
groundfact mcp                     # run as an MCP server over stdio (typed tools)
```

Zero dependencies, Node ≥ 18, single file `bin/groundfact.mjs`.

## Distribution: skill, MCP, or plugin?

All three forms compose — they are not alternatives:

| form | what it buys | status |
|---|---|---|
| **SKILL.md** | teaches any file-reading, shell-running agent the migration recipe; works across every agent, zero maintenance | shipped |
| **self-bootstrap block** | every generated file carries a `context-protocol` block instructing agents to run `groundfact check` before work — ambient invocation with no plugin at all | shipped (init sample) |
| **MCP server** | typed tools in the tool list of any MCP-capable client: `claude mcp add groundfact -- node /path/to/bin/groundfact.mjs mcp` | shipped (`groundfact mcp`, stdio JSON-RPC, zero deps) |
| **rulesync channel** | `build --rulesync` emits the rules *and* this repo's SKILL.md as a rulesync skill, so one rulesync config fans the recipe out with everything else | shipped |
| native harness plugins (Claude Code plugin, pi extension) | lifecycle hooks (auto-run `check` on session start) — the one thing a skill cannot do | deliberately not built: per-harness API treadmill; configure hooks on the rulesync side instead |

Feasibility ranking: **skill > bootstrap > MCP > native plugins**. The skill is
universal and free; the bootstrap block gets you automatic invocation without
any harness integration; the MCP server exists for environments that prefer
typed tools over shell (it is the same CLI behind a JSON-RPC facade); native
plugins are the only layer with real lock-in, and that layer belongs to
rulesync's hook/permission sync, not to this project.

## Adopting an existing hand-written file — no LLM required

`groundfact adopt ~/.pi/agent/AGENTS.md` splits the file at `##` headings and
stores every section **verbatim** into `blocks/adopted/` (original heading kept
in the frontmatter `title`). Nothing is interpreted, nothing is lost — a
round-trip is byte-content-preserving.

What a script cannot do is the semantic classification: which section is a
*fact* (should become a probe) and which is a *principle* (should stay
hand-written). The workflow defers that decision instead — the strangler
pattern:

1. `adopt` — everything becomes a user block; `build --force` takes the target
   over (the original is backed up as `.groundfact-orig`)
2. migrate one section at a time: `groundfact migrate <block-id>` creates a
   **frozen probe** that echoes the adopted text — that text is the *oracle*.
   An agent (or human) then replaces the echo with real detection and
   iterates: `probe` shows the diff against the oracle, so a hallucinated
   "fact" cannot slip through — every differing line must be explained.
   The full recipe and the classification guide (probeable / policy / history)
   live in [SKILL.md](SKILL.md).
3. delete the migrated block, `build`, and `check` guards consistency

During migration, set a target to `{"path": "...", "machine": false}` so the
machine profile and the not-yet-migrated adopted sections do not land twice in
the same file.

## Three different things called "drift"

- **reality drift** — the machine itself changed. `probe` reports it (diff
  against the previous run); rebuilding distributes it. This is not an error.
- **artifact drift** — a managed file no longer matches its sources. `check`
  reports it, split into hand edits (disk ≠ last generation) and stale sources
  (disk = last generation ≠ current sources).
- **probe volatility** — a probe whose output differs between two runs with no
  machine change. That is a probe *bug* that would cry wolf on every run;
  `probe --verify` runs everything twice and fails on it, and probe output is
  never written while any probe is volatile.

One deliberate boundary: the *translation* from hand-written fact to probe is
semantic work done once, by an agent or a human (see SKILL.md) — never at
runtime. An LLM in the probe loop would be non-deterministic, unauditable, and
an injection surface; as a one-time compiler it produces reviewable shell that
the oracle diff keeps honest.

## Data model

**Probes** (`probes.d/*.sh`): idempotent shell snippets; stdout becomes a markdown section. Probe whatever matters to you (GPUs, K8s contexts, internal endpoints, private mirrors…). Output lands in `facts/machine.md` — the machine profile is a **fact**: always probed, never hand-edited.

**Blocks** (`blocks/user/`, `blocks/project/`, `blocks/adopted/` — the last one holds mechanically adopted sections, treated as user scope):

```md
---
id: python-conventions
scope: project            # user = cross-project principle; project = conditionally assembled
targets: ["claudecode","codexcli"]   # or ["*"]
when: ["pyproject.toml", "requirements*.txt"]  # assemble only if any matches the project dir
weight: 30                # lower sorts earlier; the machine profile is always first
---
## Python project conventions
...
```

**Targets** (`groundfact.json`): any name → any path; no built-in agent list (the agent-compatibility treadmill belongs to rulesync). A target can also opt out of the machine profile (useful mid-migration):

```json
{
  "targets": {
    "claudecode": "~/.claude/CLAUDE.md",
    "pi": { "path": "~/.pi/agent/AGENTS.md", "machine": false }
  },
  "projectIncludes": ["project"],
  "projectFileName": "AGENTS.md"
}
```

## Generated-file protocol

Every managed file starts with `<!-- groundfact:generated … -->` (the adoption credential); every block is wrapped in `begin/end` markers carrying a content sha, so drift can be attributed per block. Snapshots live in `last/`; `check` compares three ways (disk / last generation / current sources) and splits drift into two kinds:

- **hand-edit drift**: disk ≠ last generation → keep it by moving the change into `blocks/`, or discard it by rebuilding
- **stale sources**: disk = last generation ≠ current sources → rebuild to sync

## Roadmap (not built yet)

- `probe --watch` / scheduled: notify on machine-facts changes (hook into OSC 7501 or a webhook, closing the loop with the herdr ecosystem)
- per-block dry-run diff: preview every target's changes before build
- team sharing: blocks from a git repo + declarative `sources` (rulesync already does this; connect directly)
- probe sandboxing and timeout policies

## License

MIT. Symbiotic with rulesync (MIT): `build --rulesync` output is its source format.
