import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parseSetup } from '../src/workspace/setups/contract/schema'

const scripts = fileURLToPath(new URL('../skills/alethe/scripts/', import.meta.url))
const python = [['python3'], ['python'], ['py', '-3']].find(([bin, ...args]) => spawnSync(bin, [...args, '--version']).status === 0)
function runPython(code, input) {
  if (!python) throw new Error('Python 3 is required for Alethe export tests')
  const result = spawnSync(python[0], [...python.slice(1), '-c', `import sys,json\nsys.path.insert(0,sys.argv[1])\n${code}`, scripts], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}
const html = readFileSync(new URL('../skills/alethe/assets/editor.html', import.meta.url), 'utf8')
const browserCode = html.slice(html.indexOf('function mapProviderToCate('), html.indexOf('\nfunction cleanSetupJson('))
const browserExport = (data, profile = 'base') => JSON.parse(JSON.stringify(vm.runInNewContext(`${browserCode}\nprofileSetups(profile, data)`, { data, profile })))
const pythonExport = (data, profile = 'base') => runPython('import setup_export\nx=json.load(sys.stdin)\nprint(json.dumps(setup_export.profile_setups(x["profile"], x["data"])))', { data, profile })
const fixture = () => ({
  providers: ['codex', 'agy'], principles: ['Keep sessions'],
  tiers: { standard: { codex: { model: 'sol', effort: 'high' } }, strong: { agy: { model: 'argon', effort: 'high' } } },
  profiles: { base: { order: ['agy', 'codex'], tiers: { standard: { codex: { effort: 'medium' } } } } },
  playbooks: { advisor: { name: 'Advisor', next: 'review-gate', phases: [
    { id: 'brief', who: 'lead', tier: 'strong', role: 'planner', readOnly: true },
    { id: 'execute', role: 'executor', tier: 'standard', provider: 'codex', does: 'Implement', gate: 'Checks pass', rules: [{ if: 'deep', use: { tier: 'strong' } }] },
    { id: 'advise', role: 'advisor', tier: 'strong', readOnly: true, if: 'stuck', after: 'execute', limit: '3 consults' },
    { id: 'resume', role: 'executor', tier: 'standard', runner: 'rescue', after: 'advise', then: 'recheck' },
    { id: 'report', who: 'lead', role: 'planner', tier: 'strong', readOnly: true },
  ] } },
})

describe('Alethe setup export', () => {
  it('keeps all bundled profiles identical between the browser and Python', () => {
    const data = runPython('import orchestrate\nprint(json.dumps(orchestrate.parse_playbooks_yaml(orchestrate.bundled_playbooks_path().read_text(encoding="utf-8"))))')
    for (const profile of Object.keys(data.profiles)) {
      expect(browserExport(data, profile)).toEqual(pythonExport(data, profile))
    }
    for (const setup of pythonExport(data)) {
      const saved = JSON.parse(readFileSync(new URL(`../skills/alethe/assets/setups/${setup.id}.json`, import.meta.url), 'utf8'))
      expect(saved).toEqual(setup)
      const parsed = parseSetup(saved, { id: setup.id })
      expect(parsed.nodes).toHaveLength(setup.nodes.length)
      expect(parsed.edges).toHaveLength(setup.edges.length)
      expect(parsed.nodes[0].prompt).toBe(setup.nodes[0].prompt)
    }
  })
  it('reuses sessions, merges every lead phase and retains conditional control flow', () => {
    const data = fixture()
    const [setup] = pythonExport(data)
    expect(browserExport(data)).toEqual([setup])
    expect(setup.nodes.map(n => n.id)).toEqual(['lead', 'execute', 'advise'])
    const flow = JSON.parse(setup.nodes[0].prompt.split('\n').at(-1))
    expect(flow.phases.find(p => p.id === 'resume').nodes).toEqual(['execute'])
    expect(flow.phases.find(p => p.id === 'report').nodes).toEqual(['lead'])
    expect(flow.phases.find(p => p.id === 'advise')).toMatchObject({ if: 'stuck', limit: '3 consults', after: 'execute' })
    expect(flow.next).toBe('review-gate')
    expect(flow.phases[1].rules).toEqual(data.playbooks.advisor.phases[1].rules)
    expect(setup.edges.every(e => e.from === 'lead')).toBe(true)
  })
  it('honors explicit providers and partial profile overrides without invented defaults', () => {
    const [setup] = pythonExport(fixture())
    expect(setup.nodes[0]).toMatchObject({ agent: 'agy', model: 'argon', tier: 'strong' })
    expect(setup.nodes[1]).toMatchObject({ agent: 'codex', model: 'sol', effort: 'medium' })
    const data = fixture(); data.playbooks.advisor.phases[1].model = 'custom-sol'
    expect(browserExport(data)).toEqual(pythonExport(data))
    expect(pythonExport(data)[0].nodes[1].model).toBe('custom-sol')
  })
  it('keeps worker counts and creates worktrees only when requested', () => {
    const data = fixture(); data.playbooks.advisor.phases[1].workers = 3
    data.playbooks.advisor.phases[1].isolate = true
    const [setup] = pythonExport(data)
    expect(browserExport(data)).toEqual([setup])
    expect(setup.nodes.filter(n => n.worktree)).toHaveLength(3)
    expect(setup.nodes[1].worktree).toBe('advisor-execute-1')
    expect(JSON.parse(setup.nodes[0].prompt.split('\n').at(-1)).phases[3].nodes).toEqual(['execute-1', 'execute-2', 'execute-3'])
  })
  it('rejects orphaned rescue phases and unsupported providers instead of changing the workflow', () => {
    for (const change of [d => { d.playbooks.advisor.phases[3].role = 'unknown' }, d => { d.playbooks.advisor.phases[1].provider = 'kimi' }, d => { d.playbooks.advisor.phases[1].provider = 'claude' }]) {
      const data = fixture(); change(data)
      expect(() => browserExport(data)).toThrow()
      expect(() => pythonExport(data)).toThrow()
    }
  })
  it('writes UTF-8 setups in directories with spaces and Unicode without shell commands', () => {
    const saved = runPython(`import setup_export,tempfile,pathlib,contextlib,io
from unittest.mock import patch
with tempfile.TemporaryDirectory(prefix="Cate testes ç ") as root:
    data=json.load(sys.stdin)
    setup=setup_export.profile_setups("base",data)[0]
    with patch("os.getcwd",return_value=root), contextlib.redirect_stdout(io.StringIO()):
        setup_export.save_single_setup_to_cate(setup,"workspace")
    result=json.loads((pathlib.Path(root)/".cate"/"setups"/(setup["id"]+".json")).read_text(encoding="utf-8"))
    print(json.dumps(result))`, fixture())
    expect(saved).toEqual(pythonExport(fixture())[0])
  })
})
