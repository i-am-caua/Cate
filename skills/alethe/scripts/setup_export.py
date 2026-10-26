#!/usr/bin/env python3
"""Export Alethe plans and profiles as Cate setups (cate-setup v1 JSON).

  setup_export.py plan <plan.json> [--out file] [--to-cate]
  setup_export.py profile <name> [--out file] [--to-cate]

Converts validated Alethe plans or playbook profiles into Cate setup specifications.
Stdlib only.
"""
import argparse, json, os, subprocess, sys
from pathlib import Path

# Add scripts directory to path to reuse alethe utilities
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

import cate_bridge
import orchestrate


# Pinned defaults used when a profile tier does not define a provider entry.
NODE_TIER_DEFAULTS = {
    "agy": {
        "cheap": {"model": "gemini-3.8-flash-low", "effort": "low"},
        "standard": {"model": "gemini-4-argon-medium", "effort": "medium"},
        "strong": {"model": "gemini-4-argon-high", "effort": "high"},
    },
    "codex": {
        "cheap": {"model": "gpt-6-luna", "effort": "low"},
        "standard": {"model": "gpt-6-luna", "effort": "medium"},
        "strong": {"model": "gpt-6-luna", "effort": "high"},
    },
    "opencode": {
        "cheap": {"model": "opencode/glm-5.3-flash-free", "effort": "low"},
        "standard": {"model": "opencode/deepseek-v4.1-flash-free", "effort": "medium"},
        "strong": {"model": "opencode/deepseek-v4.1-flash-free", "effort": "high"},
    },
    "claude-code": {
        "cheap": {"model": "claude-sonnet-5-5-medium", "effort": "medium"},
        "standard": {"model": "claude-sonnet-5-5-medium", "effort": "medium"},
        "strong": {"model": "claude-opus-5-5-high", "effort": "high"},
    },
}

# Read-only volume phases always run on the cheap tier, even when the playbook
# leaves them at the default standard tier.
CHEAP_WORKER_ROLES = {"scout", "investigate", "follow-up", "follow_up", "triage", "check", "worker"}


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

    lead_agent = resolve_lead_agent() or "agy"
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


def resolve_agent_for_phase(role, mode, tier, prof_data, parsed, who=None):
    role_lower = (role or "").lower()

    # Cheap volume phases stay on the cheap provider. Lead planner/brief phases
    # belong to the orchestrator and are merged into the lead node by export_profile.
    if tier == "cheap":
        if who == "lead" and any(k in role_lower for k in ("planner", "brief")):
            return "agy"
        if any(k in role_lower for k in ("triage", "checker", "check")):
            return "opencode"
        if any(k in role_lower for k in ("scout", "investigate", "follow-up", "follow_up", "read", "extractor", "worker")):
            return "agy"

    # 1. Judgments / high-level validation / bug hunting / architecture / advice:
    # Top tier reasoning: Agy (Gemini 4 Argon / Claude Sonnet/Opus 5.5)
    if any(k in role_lower for k in ("judge", "advisor", "consult", "bugs", "bug-hunter", "validator", "validate", "planner", "brief")):
        return "agy"
    
    # 2. Code implementation / writers / fixers:
    # Execution workers: Codex (GPT-6 Luna free)
    if any(k in role_lower for k in ("build", "builder", "fix", "fixer", "do it yourself", "execute", "writer", "do")):
        return "codex"
    
    # 3. Reviewers / checkers / skeptics / triage:
    # Strong free reasoning: OpenCode (DeepSeek V4.1 Flash score 45, GLM-5.3 Flash score 42)
    if any(k in role_lower for k in ("reviewer", "revisor", "checker", "skeptic", "conventions", "audit", "triage")):
        return "opencode"
    
    # 4. Volume scouts / bulk extraction:
    # High volume / fast reads: Agy (Gemini 3.8 Flash score 41)
    if any(k in role_lower for k in ("scout", "read", "extractor")):
        return "agy"
    
    # Fallback to tier specification:
    tier_spec = prof_data.get("tiers", {}).get(tier, {}) or parsed.get("tiers", {}).get(tier, {})
    if "agy" in tier_spec:
        return "agy"
    if "opencode" in tier_spec:
        return "opencode"
    if "codex" in tier_spec:
        return "codex"
    if "claude" in tier_spec:
        return "claude-code"
    return map_provider("auto") or "agy"


def resolve_node_spec(role, mode, tier, prof_data, parsed,
                      explicit_provider=None, explicit_model=None, explicit_effort=None):
    """Resolve the Cate agent and the pinned model/effort for one setup node."""
    tier = tier or "standard"

    agent = map_provider(explicit_provider) if explicit_provider else None
    if not agent:
        agent = resolve_agent_for_phase(role, mode, tier, prof_data, parsed)
    agent = agent or "agy"

    tier_map = prof_data.get("tiers", {}).get(tier, {}) or parsed.get("tiers", {}).get(tier, {})
    fallback_tier_map = parsed.get("tiers", {}).get(tier, {})
    prov_key = "claude" if agent == "claude-code" else agent
    spec = tier_map.get(prov_key) or fallback_tier_map.get(prov_key) or {}

    model = explicit_model or spec.get("model")
    effort = explicit_effort or spec.get("effort")

    defaults = (
        NODE_TIER_DEFAULTS.get(agent, {}).get(tier)
        or NODE_TIER_DEFAULTS.get(agent, {}).get("standard")
        or {}
    )
    model = model or defaults.get("model")
    effort = effort or defaults.get("effort")

    return {"agent": agent, "model": model, "effort": effort, "tier": tier}


def resolve_phase_tier(ph):
    """Cheap volume phases run on the cheap tier even when the playbook says standard."""
    tier = ph.get("tier") or "standard"
    role = (ph.get("role") or "").strip().lower()
    ph_id = (ph.get("id") or "").strip().lower()
    if tier == "standard" and (role in CHEAP_WORKER_ROLES or ph_id in CHEAP_WORKER_ROLES):
        return "cheap"
    return tier


def export_profile(profile_name):
    policy_path = orchestrate.default_policy_path()
    try:
        _, parsed = orchestrate.loaded_playbooks(policy_path)
    except Exception as e:
        sys.exit(f"failed to load playbooks: {e}")

    profiles = parsed.get("profiles", {})
    if profile_name not in profiles:
        avail = ", ".join(sorted(profiles.keys()))
        sys.exit(f"unknown profile '{profile_name}'. Available profiles: {avail}")

    prof_data = profiles[profile_name]
    playbooks = parsed.get("playbooks", {})
    profile_order = prof_data.get("order") or parsed.get("providers") or []
    lead_agent = (map_provider(profile_order[0]) if profile_order else None) or resolve_lead_agent() or "agy"
    lead_spec = resolve_node_spec(
        "planner", "read-only", "standard", prof_data, parsed, explicit_provider=lead_agent
    )
    setups = []

    print(
        "Note: profile export emits linear phase setups without conditional branching or escalation phases",
        file=sys.stderr,
    )

    for pb_id, pb in playbooks.items():
        setup_id = cate_bridge.slug(f"{profile_name}-{pb_id}")
        setup_name = f"{pb.get('name', pb_id)} ({profile_name})"
        phases = pb.get("phases", [])

        lead_prompt = "Orquestrar as fases do playbook usando Gemini 4 Argon."
        start_idx = 0
        if len(phases) > 1 and phases[0].get("who") == "lead":
            first_does = (phases[0].get("does") or "").strip()
            if first_does:
                lead_prompt = f"{lead_prompt}\n\n{first_does}"
            start_idx = 1

        nodes = [
            {
                "id": "lead",
                "agent": lead_spec["agent"],
                "model": lead_spec["model"],
                "effort": lead_spec["effort"],
                "tier": "standard",
                "title": "Orquestrador (Argon)",
                "orchestrator": True,
                "prompt": lead_prompt,
                "worktree": None,
                "mode": "read-only",
            }
        ]
        edges = []
        prev_node_id = "lead"

        for idx, ph in enumerate(phases[start_idx:], start=start_idx):
            ph_id = ph.get("id") or f"phase-{idx+1}"
            role = ph.get("role") or ph_id
            mode = "read-only" if ph.get("readOnly") else "write"
            tier = resolve_phase_tier(ph)
            spec = resolve_node_spec(
                role,
                mode,
                tier,
                prof_data,
                parsed,
                explicit_provider=ph.get("provider"),
                explicit_model=ph.get("model"),
                explicit_effort=ph.get("effort"),
            )
            wt = cate_bridge.slug(f"{pb_id}-{ph_id}") if (ph.get("isolate") and mode == "write") else None
            prompt = ph.get("does", "")

            nodes.append({
                "id": ph_id,
                "agent": spec["agent"],
                "model": spec["model"],
                "effort": spec["effort"],
                "tier": spec["tier"],
                "title": role,
                "orchestrator": False,
                "mode": mode,
                "worktree": wt,
                "prompt": prompt or f"Executar a fase {role}",
            })

            role_lower = role.lower()
            if any(k in role_lower for k in ("checker", "reviewer", "revisor", "verify", "audit", "gate")):
                kind = "verify"
            elif mode == "read-only" or any(k in role_lower for k in ("scout", "planner", "research")):
                kind = "context"
            else:
                kind = "trigger"

            after = ph.get("after")
            from_node = after if (after and any(n["id"] == after for n in nodes)) else prev_node_id
            edges.append({
                "from": from_node,
                "to": ph_id,
                "kind": kind,
                "label": role,
            })
            prev_node_id = ph_id

        setups.append({
            "version": 1,
            "id": setup_id,
            "name": setup_name,
            "source": "alethe",
            "nodes": nodes,
            "edges": edges,
            "budget": {"maxWorkers": len(nodes)},
        })

    return setups


def save_single_setup_to_cate(setup_data, scope="global"):
    if scope == "global":
        out_dir = os.path.expanduser("~/.cate/setups")
    else:
        out_dir = os.path.join(os.getcwd(), ".cate", "setups")
    os.makedirs(out_dir, exist_ok=True)
    dest = os.path.join(out_dir, f"{setup_data['id']}.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(setup_data, f, indent=2)
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
    args.fn(args)


if __name__ == "__main__":
    main()
