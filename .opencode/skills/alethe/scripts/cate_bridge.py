#!/usr/bin/env python3
"""Bridge: run an Alethe plan (version 1) as visible Cate agent panels.

  cate_bridge.py agents                         providers -> Cate agents, readiness
  cate_bridge.py launch PLAN [--out DIR] [--dry-run] [--canvas ID]
  cate_bridge.py wait   RUN  [--timeout S]      wait for the panels of a run
  cate_bridge.py collect RUN                    write result.md per worker from agent read
  cate_bridge.py status RUN                     panel states of a run

PLAN is the same JSON `orchestrate.py scaffold` prints and `validate` checks. RUN is the
cate-run.json that `launch` writes. Needs the `cate` CLI (a Cate terminal). Stdlib only.
"""
import argparse, json, os, re, subprocess, sys, time

PROVIDER_TO_CATE = {
    "claude": "claude-code", "codex": "codex", "agy": "agy", "antigravity": "agy",
    "opencode": "opencode", "cursor": "cursor", "grok": "grok", "kiro": "kiro",
}
INVARIANTS = (
    "\n\n---\nWorker rules (set by the orchestrator):\n"
    "- Do not delegate, spawn subagents or start another agent CLI (no `cate agent start`, no alethe).\n"
    "- Do not commit, push, tag, release or open a pull request.\n"
    "- Touch only the paths you own; leave other changes alone.\n"
    "- Finish with a short handoff: what changed, checks run and their result, what remains.\n"
)


def cate(*args, check=True):
    p = subprocess.run(["cate", *args], capture_output=True, text=True)
    if check and p.returncode not in (0,):
        sys.exit(f"cate {' '.join(args[:3])} failed ({p.returncode}): {(p.stderr or p.stdout).strip()}")
    return p


def cate_json(*args, check=True):
    p = cate(*args, "--json", check=check)
    try:
        return json.loads(p.stdout) if p.stdout.strip() else None
    except ValueError:
        return None


def require_cate():
    if not os.environ.get("CATE_SOCKET") or not os.environ.get("CATE_TOKEN"):
        sys.exit("not in a Cate terminal (CATE_SOCKET/CATE_TOKEN unset); use orchestrate.py run instead")


def agent_types():
    return {a["agentId"]: bool(a.get("ready")) for a in (cate_json("agent", "types") or [])}


def pick_agent(provider, types):
    if provider == "auto":
        for cand in ("codex", "claude-code", "agy", "opencode"):
            if types.get(cand):
                return cand, None
        return None, "no ready Cate agent for provider auto"
    agent = PROVIDER_TO_CATE.get(provider)
    if not agent:
        return None, f"provider '{provider}' has no Cate agent; run it with orchestrate.py"
    if not types.get(agent):
        return None, f"Cate agent '{agent}' is not set up/ready in this workspace"
    return agent, None


def slug(s):
    return re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")[:40] or "x"


def build_prompt(w, plan_dir):
    task = w.get("task")
    if task is None:
        tf = w["taskFile"]
        tf = tf if os.path.isabs(tf) else os.path.join(plan_dir, tf)
        with open(tf, encoding="utf-8") as f:
            task = f.read()
    mode = ("READ-ONLY: do not modify, create or delete any file."
            if w.get("mode") == "read-only" else "You may write, only inside the paths you own.")
    return f"{task.strip()}\n\nMode: {mode}{INVARIANTS}"


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def cmd_agents(_):
    require_cate()
    types = agent_types()
    for prov, agent in sorted(PROVIDER_TO_CATE.items()):
        print(f"{prov:12} -> {agent:12} {'ready' if types.get(agent) else 'not ready'}")
    print("kimi / custom -> no Cate agent (use orchestrate.py run)")


def supports_relations():
    force = os.environ.get("CATE_BRIDGE_FORCE_RELATIONS")
    if force is not None:
        return force.strip().lower() in ("1", "true", "yes", "on")
    p1 = subprocess.run(["cate", "agent", "start", "--help"], capture_output=True, text=True)
    if "--from" not in p1.stdout and "--from" not in p1.stderr:
        return False
    p2 = subprocess.run(["cate", "relation", "--help"], capture_output=True, text=True)
    return p2.returncode == 0


def resolve_lead_panel():
    curr = cate_json("panel", "current", check=False)
    if isinstance(curr, dict) and curr.get("panelId"):
        return curr["panelId"]
    if isinstance(curr, str) and curr.strip() and not curr.strip().startswith("("):
        return curr.strip()
    panels_list = cate_json("panel", "list", check=False) or []
    for p in panels_list:
        if isinstance(p, dict) and p.get("focused") and p.get("panelId"):
            return p["panelId"]
    for p in panels_list:
        if isinstance(p, dict) and p.get("type") == "terminal" and p.get("panelId"):
            return p["panelId"]
    for p in panels_list:
        if isinstance(p, dict) and p.get("panelId"):
            return p["panelId"]
    return None


def infer_role(w):
    why = w.get("why", "").strip()
    if why:
        if ":" in why:
            return why.split(":", 1)[0].strip()
        return why[:30]
    return w.get("id", "worker")


def infer_kind(w, plan):
    link = w.get("link") or {}
    if link.get("kind"):
        return link["kind"]
    wid = str(w.get("id") or "").lower()
    why = str(w.get("why") or "").lower()
    phase = str(plan.get("phase") or "").lower()
    combined = f"{wid} {why} {phase}"
    for kw in ("review", "verify", "audit", "checker", "check", "test"):
        if kw in combined:
            return "verify"
    if w.get("mode") == "read-only":
        for kw in ("research", "scout", "explore", "read", "investigate", "context", "search"):
            if kw in combined or plan.get("strategy") == "research":
                return "context"
        if plan.get("strategy") == "research":
            return "context"
    return "trigger"


def topological_sort(workers):
    worker_map = {w["id"]: w for w in workers}
    in_degree = {w["id"]: 0 for w in workers}
    adj = {w["id"]: [] for w in workers}

    for w in workers:
        wid = w["id"]
        link = w.get("link") or {}
        parent = link.get("from")
        if parent and parent != "lead":
            if parent not in worker_map:
                sys.exit(f"worker '{wid}' link.from refers to unknown worker '{parent}'")
            if parent == wid:
                sys.exit(f"worker '{wid}' cannot link to itself")
            adj[parent].append(wid)
            in_degree[wid] += 1

    queue = [w["id"] for w in workers if in_degree[w["id"]] == 0]
    sorted_ids = []
    while queue:
        curr = queue.pop(0)
        sorted_ids.append(curr)
        for neighbor in adj[curr]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if len(sorted_ids) != len(workers):
        cycle_workers = [wid for wid, deg in in_degree.items() if deg > 0]
        sys.exit(f"cycle detected in worker links involving: {', '.join(cycle_workers)}")

    return [worker_map[wid] for wid in sorted_ids]


def cmd_launch(a):
    require_cate()
    plan = load(a.plan)
    plan_dir = os.path.dirname(os.path.abspath(a.plan))
    types = agent_types()
    title = plan.get("title", "alethe")
    out = a.out or os.path.join(plan_dir, "cate-" + slug(title))
    os.makedirs(out, exist_ok=True)
    run = {"version": 1, "title": title, "plan": os.path.abspath(a.plan), "out": out, "workers": {}}

    workers = topological_sort(plan.get("workers", []))
    rel_support = supports_relations()
    lead_panel = None

    if rel_support:
        lead_panel = resolve_lead_panel() or "lead"
        if a.dry_run:
            print(f"[dry-run] cate relation orchestrator {lead_panel} on")
        else:
            p = cate("relation", "orchestrator", lead_panel, "on", check=False)
            if p.returncode != 0:
                print(f"note: could not mark lead panel {lead_panel} as orchestrator: {(p.stderr or p.stdout).strip()}", file=sys.stderr)
    else:
        print("links were not drawn because this Cate build lacks cate relation", file=sys.stderr)

    skipped = []
    for w in workers:
        wid = w["id"]
        agent, why = pick_agent(w["provider"], types)
        if not agent:
            skipped.append((wid, why))
            continue
        flags = ["--agent", agent, "--title", f"{wid}: {w.get('why', title)}"[:80]]
        wt = None
        if w.get("isolate") and w.get("mode") == "write":
            wt = slug(f"{title}-{wid}")
            flags += ["--new-worktree", wt]
        if a.canvas:
            flags += ["--canvas", a.canvas]
        if w.get("model"):
            flags += ["--model", str(w["model"])]
        if w.get("effort"):
            flags += ["--effort", str(w["effort"])]

        link = w.get("link") or {}
        link_from = link.get("from")
        kind = link.get("kind") or infer_kind(w, plan)
        label = link.get("label") or infer_role(w)

        starts_from_lead = (link_from in (None, "", "lead"))
        if rel_support and starts_from_lead:
            flags += ["--from", lead_panel, "--kind", kind, "--label", label]

        notes = []
        prompt = build_prompt(w, plan_dir)
        entry = {"agent": agent, "worktree": wt, "mode": w.get("mode"), "notes": notes}

        relation_id = None
        linked_from = None

        if a.dry_run:
            print(f"[dry-run] {wid}: cate agent start {' '.join(flags)}  (prompt {len(prompt)} chars) {notes}")
            if rel_support:
                if starts_from_lead:
                    linked_from = "lead"
                else:
                    parent_panel = run["workers"].get(link_from, {}).get("panel") or f"<{link_from}-panel>"
                    this_panel = f"<{wid}-panel>"
                    lbl_disp = f'"{label}"' if " " in label else label
                    print(f"[dry-run] {wid}: cate relation add {parent_panel} {this_panel} --kind {kind} --label {lbl_disp}")
                    linked_from = link_from
            entry["panel"] = f"<{wid}-panel>"
        else:
            p = cate("agent", "start", *flags, prompt)
            panel_id = None
            for line in p.stdout.splitlines():
                parts = line.strip().split()
                if len(parts) >= 2:
                    if parts[0] == "panel":
                        panel_id = parts[1]
                    elif parts[0] == "relation":
                        relation_id = parts[1]
            if not panel_id and p.stdout.strip():
                panel_id = p.stdout.strip().split()[-1]
            entry["panel"] = panel_id
            print(f"{wid}: panel {entry['panel']} ({agent}{', worktree ' + wt if wt else ''})")

            if rel_support:
                if starts_from_lead:
                    linked_from = "lead"
                else:
                    parent_panel = run["workers"].get(link_from, {}).get("panel")
                    if parent_panel and panel_id:
                        p_rel = cate("relation", "add", parent_panel, panel_id, "--kind", kind, "--label", label, check=False)
                        if p_rel.returncode == 0:
                            for line in p_rel.stdout.splitlines():
                                parts = line.strip().split()
                                if len(parts) >= 2 and parts[0] == "relation":
                                    relation_id = parts[1]
                        else:
                            print(f"note: failed to create relation {parent_panel} -> {panel_id}: {(p_rel.stderr or p_rel.stdout).strip()}", file=sys.stderr)
                    linked_from = link_from

        if rel_support:
            entry["relationId"] = relation_id
            entry["linkedFrom"] = linked_from

        run["workers"][wid] = entry
    for wid, why in skipped:
        print(f"SKIPPED {wid}: {why}", file=sys.stderr)
    run["skipped"] = [{"id": i, "why": y} for i, y in skipped]
    if not a.dry_run:
        path = os.path.join(out, "cate-run.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(run, f, indent=2)
        print(f"run file: {path}")
    if skipped:
        sys.exit(3 if not run["workers"] else 0)


def panels(run):
    return [v["panel"] for v in run["workers"].values() if v.get("panel")]


def cmd_wait(a):
    require_cate()
    run = load(a.run)
    ids = panels(run)
    deadline = time.time() + a.timeout
    while True:
        p = cate("agent", "wait", *ids, "--wait-timeout", "60000", check=False)
        if p.returncode == 0:
            print(p.stdout.strip())
            return
        if time.time() > deadline:
            print(p.stdout.strip())
            sys.exit(1)


def cmd_status(a):
    require_cate()
    ids = panels(load(a.run))
    print(cate("agent", "list").stdout)
    print("run panels:", " ".join(ids))


def cmd_collect(a):
    require_cate()
    run = load(a.run)
    for wid, e in run["workers"].items():
        if not e.get("panel"):
            continue
        # `wait` can return before the turn registers; poll until an answer exists.
        for _ in range(15):
            d = cate_json("agent", "read", e["panel"], check=False) or {}
            msgs = [m for m in d.get("messages", []) if m.get("role") == "assistant"]
            if msgs and d.get("canReceivePrompt", True):
                break
            time.sleep(2)
        text = msgs[-1]["text"] if msgs else "(no assistant message)"
        wd = os.path.join(run["out"], "workers", wid)
        os.makedirs(wd, exist_ok=True)
        with open(os.path.join(wd, "result.md"), "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"{wid}: {d.get('state')} -> {os.path.join(wd, 'result.md')}"
              + (f"  worktree: {e['worktree']}" if e.get("worktree") else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("agents").set_defaults(fn=cmd_agents)
    l = sp.add_parser("launch")
    l.add_argument("plan"); l.add_argument("--out"); l.add_argument("--canvas")
    l.add_argument("--dry-run", action="store_true"); l.set_defaults(fn=cmd_launch)
    w = sp.add_parser("wait"); w.add_argument("run"); w.add_argument("--timeout", type=int, default=1800)
    w.set_defaults(fn=cmd_wait)
    c = sp.add_parser("collect"); c.add_argument("run"); c.set_defaults(fn=cmd_collect)
    s = sp.add_parser("status"); s.add_argument("run"); s.set_defaults(fn=cmd_status)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
