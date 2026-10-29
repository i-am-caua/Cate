#!/usr/bin/env python3
"""Export Alethe plans and profiles as Cate setups (cate-setup v1 JSON).

  setup_export.py plan <plan.json> [--out file] [--to-cate]
  setup_export.py profile <name> [--out file] [--to-cate]

Converts validated Alethe plans or playbook profiles into Cate setup specifications.
Stdlib only.
"""
import argparse, json, os, sys
from pathlib import Path

# Add scripts directory to path to reuse alethe utilities
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import cate_bridge
import orchestrate


def map_provider(prov):
    prov = (prov or "").lower()
    if prov in ("claude", "claude-code"):
        return "claude-code"
    if prov == "codex":
        return "codex"
    if prov in ("agy", "antigravity"):
        return "agy"
    if prov == "opencode":
        return "opencode"
    if prov == "cursor":
        return "cursor"
    if prov == "grok":
        return "grok"
    if prov == "kiro":
        return "kiro"
    if prov == "auto":
        try:
            types = cate_bridge.cate_json("agent", "types", check=False) or []
        except Exception:
            types = []
        for a in types:
            if a.get("ready"):
                return a.get("agentId")
        return None
    return None


def resolve_lead_agent():
    try:
        lead_panel = cate_bridge.resolve_lead_panel()
        if lead_panel:
            agents = cate_bridge.cate_json("agent", "list", check=False) or []
            for a in agents:
                if a.get("panelId") == lead_panel and a.get("agentId"):
                    return a["agentId"]
    except Exception:
        pass
    return None


def export_plan(plan_path):
    plan_file = Path(plan_path).resolve()
    with open(plan_file, "r", encoding="utf-8") as f:
        raw_plan = json.load(f)

    try:
        validated = orchestrate.validate_plan(raw_plan, plan_file)
    except orchestrate.PlanError as e:
        if "unsupported provider" in str(e):
            validated = raw_plan
        else:
            sys.exit(f"plan validation error: {e}")

    title = validated.get("title") or raw_plan.get("title") or "alethe"
    setup_id = cate_bridge.slug(title)
    plan_dir = plan_file.parent

    try:
        _, parsed = orchestrate.loaded_playbooks(orchestrate.default_policy_path())
    except Exception:
        parsed = {}
    profiles = parsed.get("profiles", {})
    prof_data = profiles.get(parsed.get("profile") or "base", {}) or {}

    lead_agent = resolve_lead_agent() or next(iter(provider_order(prof_data, parsed)), None)
    lead_spec = resolve_node_spec(
        "planner", "read-only", "standard", prof_data, parsed, explicit_provider=lead_agent
    )
    nodes = [
        {
            "id": "lead",
            "agent": lead_spec["agent"],
            "model": lead_spec["model"],
            "effort": lead_spec["effort"],
            "tier": "standard",
            "title": "Orquestrador",
            "orchestrator": True,
            "prompt": "Coordenar o fluxo de tarefas.",
            "worktree": None,
            "mode": "read-only",
        }
    ]
    edges = []

    workers = validated.get("workers", [])
    valid_worker_ids = set()

    for w in workers:
        wid = w["id"]
        prov = (w.get("provider") or w.get("requestedProvider") or "").lower()

        if prov in ("kimi", "custom"):
            print(f"omitted worker '{wid}': provider '{prov}' has no Cate agent", file=sys.stderr)
            continue

        agent = map_provider(prov)
        if not agent and prov != "auto":
            print(f"omitted worker '{wid}': provider '{prov}' has no Cate agent", file=sys.stderr)
            continue

        title_worker = w.get("why") or wid
        mode = w.get("mode", "read-only")
        wt = cate_bridge.slug(f"{title}-{wid}") if (w.get("isolate") and mode == "write") else None

        task = w.get("task")
        if task is None and "taskFile" in w:
            tf = w["taskFile"]
            tf = tf if os.path.isabs(tf) else os.path.join(plan_dir, tf)
            try:
                with open(tf, encoding="utf-8") as tf_f:
                    task = tf_f.read()
            except Exception:
                task = ""

        tier = w.get("tier") or "standard"
        spec = resolve_node_spec(
            w.get("why") or wid,
            mode,
            tier,
            prof_data,
            parsed,
            explicit_provider=agent,
            explicit_model=w.get("model"),
            explicit_effort=w.get("effort"),
        )

        nodes.append({
            "id": wid,
            "agent": spec["agent"],
            "model": spec["model"],
            "effort": spec["effort"],
            "tier": spec["tier"],
            "title": title_worker,
            "orchestrator": False,
            "mode": mode,
            "worktree": wt,
            "prompt": task or f"Executar a tarefa {title_worker}",
        })
        valid_worker_ids.add(wid)

    for w in workers:
        wid = w["id"]
        if wid not in valid_worker_ids:
            continue

        link = w.get("link") or {}
        from_id = link.get("from") or "lead"
        if from_id != "lead" and from_id not in valid_worker_ids:
            from_id = "lead"

        kind = link.get("kind") or cate_bridge.infer_kind(w, validated)
        label = link.get("label") or cate_bridge.infer_role(w)

        edges.append({
            "from": from_id,
            "to": wid,
            "kind": kind,
            "label": label,
        })

    setup = {
        "version": 1,
        "id": setup_id,
        "name": title,
        "source": "alethe",
        "nodes": nodes,
        "edges": edges,
        "budget": {"maxWorkers": len(nodes)},
    }
    return setup


def provider_order(prof_data, parsed):
    providers = parsed.get("providers", [])
    order = prof_data.get("order", providers)
    return list(dict.fromkeys([p for p in order if p in providers] + providers))


def resolve_node_spec(role, mode, tier, prof_data, parsed,
                      explicit_provider=None, explicit_model=None, explicit_effort=None):
    """Resolve the declared profile, never infer providers or tiers from role names."""
    tier = tier or "standard"
    order = provider_order(prof_data, parsed)
    provider = explicit_provider if explicit_provider and explicit_provider != "auto" else next(iter(order), None)
    agent = map_provider(provider) if provider and provider != "auto" else None
    if not agent or agent not in {map_provider(p) for p in order}:
        raise orchestrate.PlanError(f"provider {provider!r} is unavailable in this profile or has no Cate agent")
    key = "claude" if agent == "claude-code" else agent
    spec = {**parsed.get("tiers", {}).get(tier, {}).get(key, {}),
            **prof_data.get("tiers", {}).get(tier, {}).get(key, {})}
    return {"agent": agent, "model": explicit_model or spec.get("model"),
            "effort": explicit_effort or spec.get("effort"), "tier": tier}


FLOW_INSTRUCTIONS = """Coordinate this playbook using the existing panels identified by setup node id.
Only the orchestrator dispatches work, using cate agent send; wait/read replies before deciding the next phase.
Evaluate if/with branches, gates and first-matching rules; retain limits, then/after, quota and budget policies.
A rescue phase reuses its assigned panel and session; never start a replacement executor for a continuation.
Conditional phases remain idle until their condition holds. Do not execute every phase as a linear sequence.
Worker counts are capacity: dispatch only the units that need a phase, including individual rescue follow-ups.
Panel model/effort are the baseline. If a rule needs a different model, report the required escalation before proceeding.
Worktrees and read-only modes are requirements to enforce when dispatching, not evidence of sandbox enforcement.
Workflow (phase nodes reference the setup ids; map these to the launched panel ids):"""


def profile_setups(profile_name, parsed):
    profiles = parsed.get("profiles", {})
    if profile_name not in profiles:
        raise orchestrate.PlanError(f"unknown profile {profile_name!r}")
    prof = profiles[profile_name]
    setups = []
    for pb_id, pb in parsed.get("playbooks", {}).items():
        phases = pb.get("phases", [])
        lead_phase = next((p for p in phases if p.get("who") == "lead"), {"tier": "strong", "readOnly": True})
        lead_spec = resolve_node_spec("planner", "read-only", lead_phase.get("tier"), prof, parsed,
                                      lead_phase.get("provider"), lead_phase.get("model"), lead_phase.get("effort"))
        nodes = [{"id": "lead", **lead_spec, "title": "Orquestrador", "orchestrator": True,
                  "mode": "read-only", "worktree": None}]
        assignments = []
        sessions = []
        used = {"lead"}
        for i, ph in enumerate(phases):
            phase_id = ph.get("id") or f"phase-{i + 1}"
            role = ph.get("role") or phase_id
            if ph.get("who") == "lead":
                ids = ["lead"]
            elif ph.get("runner") == "rescue":
                prior = next((entry for entry in reversed(sessions) if entry[0] == role), None)
                if not prior:
                    raise orchestrate.PlanError(f"{pb_id}/{phase_id}: rescue needs an earlier {role!r} session")
                ids = prior[1]
                # Continuations keep their original model, checkout and read-only mode.
            else:
                mode = "read-only" if ph.get("readOnly") else "write"
                spec = resolve_node_spec(role, mode, ph.get("tier"), prof, parsed,
                                         ph.get("provider"), ph.get("model"), ph.get("effort"))
                ids = []
                for index in range(ph.get("workers") or 1):
                    node_id = cate_bridge.slug(phase_id + (f"-{index + 1}" if (ph.get("workers") or 1) > 1 else ""))
                    if node_id in used:
                        raise orchestrate.PlanError(f"{pb_id}: duplicate node id {node_id!r}")
                    used.add(node_id)
                    ids.append(node_id)
                    nodes.append({"id": node_id, **spec, "title": role, "orchestrator": False,
                                  "mode": mode, "worktree": cate_bridge.slug(f"{pb_id}-{node_id}") if ph.get("isolate") and mode == "write" else None,
                                  "prompt": ph.get("does") or f"Execute phase {role}"})
                sessions.append((role, ids))
            assignments.append({**ph, "id": phase_id, "nodes": ids})
        workflow = {"playbook": pb_id, "profile": profile_name,
                    "principles": parsed.get("principles", []),
                    "quota": {**parsed.get("quota", {}), **prof.get("quota", {})},
                    "budget": parsed.get("budget", {}), "next": pb.get("next"), "phases": assignments}
        nodes[0]["prompt"] = FLOW_INSTRUCTIONS + "\n" + json.dumps(workflow, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        # Star relations keep dispatch and conditional decisions with the orchestrator.
        edges = [{"from": "lead", "to": n["id"],
                  "kind": "context" if n["mode"] == "read-only" else "trigger", "label": n["title"]}
                 for n in nodes[1:]]
        setups.append({"version": 1, "id": cate_bridge.slug(f"{profile_name}-{pb_id}"),
                       "name": f"{pb.get('name', pb_id)} ({profile_name})", "source": "alethe",
                       "description": prof.get("summary", ""), "nodes": nodes, "edges": edges,
                       "budget": {"maxWorkers": len(nodes)}})
    return setups


def export_profile(profile_name):
    _, parsed = orchestrate.loaded_playbooks(orchestrate.default_policy_path())
    return profile_setups(profile_name, parsed)


def save_single_setup_to_cate(setup_data, scope="global"):
    if scope == "global":
        out_dir = os.path.expanduser("~/.cate/setups")
    else:
        out_dir = os.path.join(os.getcwd(), ".cate", "setups")
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{setup_data['id']}.json")
    orchestrate.atomic_write_text(Path(dest), json.dumps(setup_data, indent=2, ensure_ascii=False) + "\n")
    print(f"saved {scope} setup: {dest}")


def cmd_plan(args):
    setup = export_plan(args.plan)
    if args.to_cate:
        scope = "global" if getattr(args, "global_scope", False) else "workspace"
        save_single_setup_to_cate(setup, scope=scope)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(setup, f, indent=2)
        if not args.to_cate:
            print(f"wrote setup to {args.out}")
    if not args.out and not args.to_cate:
        print(json.dumps(setup, indent=2))


def cmd_profile(args):
    setups = export_profile(args.name)
    if args.to_cate:
        scope = "workspace" if getattr(args, "workspace", False) else "global"
        for s in setups:
            save_single_setup_to_cate(s, scope=scope)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(setups, f, indent=2)
        if not args.to_cate:
            print(f"wrote setups to {args.out}")
    if not args.out and not args.to_cate:
        print(json.dumps(setups, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)

    plan_parser = sp.add_parser("plan", help="export an Alethe plan as a cate-setup")
    plan_parser.add_argument("plan", help="path to plan.json")
    plan_parser.add_argument("--out", help="destination file path")
    plan_parser.add_argument("--to-cate", action="store_true", help="write to Cate setups (.cate/setups/ or ~/.cate/setups/)")
    plan_parser.add_argument("--global", dest="global_scope", action="store_true", help="save to global ~/.cate/setups instead of workspace")
    plan_parser.set_defaults(fn=cmd_plan)

    prof_parser = sp.add_parser("profile", help="export playbooks for a profile as cate-setups")
    prof_parser.add_argument("name", help="profile name (e.g. base, savings, aggressive)")
    prof_parser.add_argument("--out", help="destination file path")
    prof_parser.add_argument("--to-cate", action="store_true", help="write to Cate setups (default: global ~/.cate/setups/)")
    prof_parser.add_argument("--workspace", action="store_true", help="write to current workspace (.cate/setups) instead of global")
    prof_parser.set_defaults(fn=cmd_profile)

    args = ap.parse_args()
    try:
        args.fn(args)
    except orchestrate.PlanError as error:
        ap.exit(2, f"{error}\n")


if __name__ == "__main__":
    main()
