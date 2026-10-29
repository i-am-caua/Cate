# Alethe + Cate

Local extension. Read it when `CATE_SOCKET` and `CATE_TOKEN` are set (you are in a Cate terminal)
or the user mentions Cate. Otherwise ignore it. Read the `cate-cli` skill (`references/agents.md`)
before the first `cate agent` command.

Division of labor:

- **Alethe** decides: playbook, profile, tiers, briefs, budget, quota, report, `mark`.
- **Cate** shows and runs: each worker is a visible agent panel, optionally in its own worktree.

Never use both to run the same worker.

## Execution backend: Cate panels are default

When `CATE_SOCKET` and `CATE_TOKEN` are set and `cate version` works, the **DEFAULT** execution backend
is Cate panels (via `scripts/cate_bridge.py launch <plan>`), with visual relation links drawn on the canvas.

The Alethe runner (`orchestrate.py run`) is used only when:
- The user explicitly asks for it or requests background execution,
- The worker's provider has no ready Cate agent (`kimi`, `custom`, or not ready in `cate agent types`), or
- A hard budget must be enforced.

The lead's own panel is the orchestrator: before launching workers, mark it with
`cate relation orchestrator <own panel> on` (own panel id from `cate panel current` or
`cate panel list --json` focused/calling panel), and workers are started from it with `--from`.

An explicit user choice ("use Cate", "run it in the background") wins. A `cate` call denied by
permissions is not worked around: name the Settings → CLI row to enable, then fall back to the
Alethe runner.

## Setup import and links: the bridge script

An Alethe "setup" is a plan (workers, providers, tiers, modes, briefs) that you build for the task
from what is installed and logged in. `scripts/cate_bridge.py` imports it into Cate automatically:

```bash
S=<skill dir>/scripts
python3 $S/orchestrate.py probe                       # what the machine has
python3 $S/cate_bridge.py agents                      # which of those Cate can start, and ready state
python3 $S/orchestrate.py scaffold parallel --workers 3 > /tmp/plan.json   # fill it in
python3 $S/orchestrate.py validate /tmp/plan.json
python3 $S/cate_bridge.py launch /tmp/plan.json --dry-run   # preview the panels and links
python3 $S/cate_bridge.py launch /tmp/plan.json             # start them in Cate
python3 $S/cate_bridge.py wait    <out>/cate-run.json
python3 $S/cate_bridge.py collect <out>/cate-run.json       # <out>/workers/<id>/result.md
```

### Links and relations behavior in `launch`

- **Feature detection**: `launch` checks for relation support with `cate agent start --help | grep -q -- '--from'` and `cate relation --help`.
  - Testing aid: override detection by setting `CATE_BRIDGE_FORCE_RELATIONS=1` (force on) or `0` (force off).
  - If relation support is absent, `launch` falls back to plain `cate agent start` and prints a warning on stderr:
    `links were not drawn because this Cate build lacks cate relation`.
- **Orchestrator lead**: With relation support, `launch` marks the lead panel as orchestrator (`cate relation orchestrator <lead> on`).
- **Automatic link inference**: Workers starting from lead are launched with `--from <lead> --kind <kind> --label <role>`.
  - `--kind verify` is used for review/verify/audit/checker workers.
  - `--kind context` is used for read-only research/scout workers.
  - `--kind trigger` is the default.
- **Worker chaining via `link`**: Plans can specify an optional `link` object on workers:
  ```json
  {"from": "<worker id or 'lead'>", "kind": "trigger|verify|context|use", "label": "<text>"}
  ```
  When `from` is another worker id, workers are ordered topologically (cycles are rejected with an error). After both panels exist, the link is created via `cate relation add <fromPanel> <toPanel> --kind <kind> --label <label>`.
- **Run metadata**: `cate-run.json` records `relationId` and `linkedFrom` for each worker.

## Setup export: `setup_export.py`

`scripts/setup_export.py` converts Alethe plans or profiles into Cate setup specifications (`cate-setup` v1 JSON):

```bash
# Export a plan to cate-setup v1 JSON
python3 $S/setup_export.py plan /tmp/plan.json [--out setup.json] [--to-cate]

# Export all playbooks for a profile (base, savings, aggressive)
python3 $S/setup_export.py profile base [--out setups.json] [--to-cate]
```

- **Provider mapping**: `claude`→`claude-code`, `codex`→`codex`, `agy`/`antigravity`→`agy`, `opencode`→`opencode`, `auto`→first ready Cate agent (or `null`). `kimi` and `custom` are omitted with a stderr notice.
- **`--to-cate`**: Writes profile setups to `~/.cate/setups/<id>.json` by default;
  `--workspace` selects `<cwd>/.cate/setups/`. Plan exports default to the workspace
  (`--global` selects the user directory). Cate reads these files directly.

Profile exports and the HTML editor use the declared provider order and tier settings,
including partial profile overrides and explicit phase provider/model/effort. Roles do
not silently select a different provider or downgrade a tier. Pin `provider` on a phase
when, for example, execution should use Codex and advice should use Agy.

A setup describes persistent agent panels, not a linear list of phase instances:

- Every `who: lead` phase belongs to the orchestrator panel.
- A `rescue` phase reuses the earlier panels with the same role, preserving sessions
  and worktrees. A rescue without an earlier matching role fails export.
- `workers` declares the number of available panels; only `isolate: true` writing
  phases request new worktrees.
- The orchestrator's role prompt retains the full phase-to-panel mapping, conditions,
  gates, rules, limits, quota/budget settings and next playbook. Relations connect
  workers to the orchestrator so workers do not trigger conditional phases themselves.

Cate opens panels idle by default. When applying with an initial task, it creates the
workers first and includes their actual panel ids, role prompts and setup instructions
in the orchestrator's initial prompt. Conditions and resumption are coordinated by
that agent through `cate agent send`, not executed by a separate workflow scheduler.
Without an initial task, the saved role prompts remain reference instructions in the
setup preview; no workflow is automatically dispatched.

## Cate panel waves (by hand)

1. Plan as usual (`new`, plan JSON, `dry-run`, preview). Alethe's budget and quota checks still
   apply. Cate panels do not enforce `budget`; you do: count the panels you start.
2. Map each plan worker to one panel. `cate agent types` lists usable agents; map the worker's
   provider (`codex`, `claude`, ...) to one of them. A provider that is not listed goes to the
   Alethe runner.
3. Start workers, one id each. Writers get `--new-worktree <name>` (disjoint ownership, as in
   SKILL.md); read-only workers use your checkout. Pass the brief from
   [briefs.md](briefs.md) as the prompt, including the worker contract invariants, since the
   Alethe runner is not appending them here. Use `--title "<role>: <why>"`.

   ```bash
   id=$(cate agent start --agent codex --new-worktree api-v2-billing --title "writer: billing v2" "<brief>")
   ```

4. Wait: `cate agent wait <ids...> --wait-timeout 60000`, repeating while it exits 1. Do not poll
   in a tight loop and do not read raw terminal screens unless `agent read` fails.
5. Collect: `cate agent read <id> --json`; take the last assistant message as the worker's
   result. For writers, review the worktree diff (`git -C <worktree> diff`), not the chat.
6. A follow-up goes to the same panel with `cate agent send <id> "<bounded prompt>"` instead of
   a new worker. A stuck or wrong worker: `cate agent interrupt`, then send a corrected brief or
   start a fresh worker with a compact handoff.
7. After context compaction run `status` and `cate agent list` before anything else.

## Keep the report honest

The runner does not see Cate panels, so record them yourself:

- Note in the orchestration's `why` or your final message which workers ran as Cate panels, with
  panel ids and worktree names.
- No token or cost figures exist for panel workers unless the agent printed them. Report them as
  "not measured"; never estimate them as reported spend.
- `mark <worker> used|partial|discarded` only applies to runner workers. For panel workers say
  the outcome in your closing message.
- Leave worktrees in place until the user has reviewed them. Close panels only with the user's
  agreement (`cate panel close` fails on unsaved work; never pass `--discard` unasked).

## Rules

- A worker running in a Cate panel must not itself call `cate agent start` or alethe. The brief
  says so.
- Keep one writer per path set, even across panels.
- Typing into terminals (`cate terminal type/press`) is not part of orchestration. Use
  `agent send`.
- Use `cate review` panels only when the user asked for a review panel.
