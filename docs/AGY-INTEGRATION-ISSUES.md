# Diagnóstico e Registro de Pendências: Integração do `agy` (Antigravity) no Cate

**Data de Registro:** 25 de Outubro de 2026
**Contexto:** O agente `agy` foi introduzido manualmente pelo desenvolvedor na branch local do Cate (`~/cate`). Os testes unitários e de integração de agentes do Cate possuem asserções de paridade estrita (matrizes de teste que cobrem todos os CLIs suportados: Claude Code, Codex, Cursor, Grok, Kiro, OpenCode e agora Agy).

Atualmente, existem 8 falhas em testes relacionadas exclusivamente à presença do `agy` e ausência de alguns fixtures/parsers de evento específicos para ele.

---

## Resumo dos 8 Testes com Falha

### 1. `src/services/agents/runtime/start.test.ts`
- **Teste:** `agent start > lists every agent CLI with whether it can start here`
- **Erro:** `AssertionError: expected [ 'claude-code', 'codex', …(5) ] to deeply equal [ 'claude-code', 'codex', …(4) ]`
- **Causa:** O teste compara a lista retornada por `agents.types()` contra uma lista estática esperada de IDs de agentes que ainda não incluía `'agy'`.
- **Como resolver:** Atualizar a lista de expectativa no teste para incluir `'agy'`.

### 2. `src/services/agents/runtime/status.integration.test.ts`
- **Teste:** `coding-agent hook status integration > covers every registered coding-agent CLI`
- **Erro:** `AssertionError: expected [ 'claude-code', 'codex', …(4) ] to deeply equal [ 'agy', 'claude-code', 'codex', …(4) ]`
- **Causa:** O teste verifica se todos os coding agents registrados possuem uma suíte de integração de status. O `agy` está registrado no enum/registro, mas falta o caso correspondente na tabela de testes.
- **Como resolver:** Adicionar caso para `'agy'` no loop do teste de integração de status.

### 3. `src/services/agents/runtime/terminal.test.ts` (Passos / Steps)
- **Teste:** `terminal agents steps > agy: a completed edit and command are steps of the panel, named the same way`
- **Erro:** `AssertionError: expected [] to deeply equal [ [ 'term', 'src/created.txt' ], …(1) ]`
- **Causa:** O parser de eventos do `agy` não gerou os passos de painel esperados (`term` / arquivo modificado) a partir dos eventos simulados no teste.
- **Como resolver:** Revisar o mapeamento de eventos de ferramentas/edição em `src/services/agents/contract/hooks.ts` ou no handler de terminal do `agy`.

### 4. `src/services/agents/runtime/terminal.test.ts` (Matriz de agentes)
- **Teste:** `terminal agentTerminals input and hook ordering > covers every CLI agent`
- **Erro:** `AssertionError: expected [ 'claude-code', 'codex', …(4) ] to deeply equal [ 'agy', 'claude-code', 'codex', …(4) ]`
- **Causa:** Matriz de cobertura de entrada e ordem de hooks não contempla o `'agy'`.
- **Como resolver:** Adicionar `'agy'` ao array de teste do fixture.

### 5. `src/services/agents/runtime/hooks/agentHooks.test.ts`
- **Teste:** `agentHooks capability > Settings inspection exposes config metadata and explicit signal availability for every CLI`
- **Erro:** `AssertionError: expected [ 'agy', 'cursor', 'kiro' ] to deeply equal [ 'cursor', 'kiro' ]`
- **Causa:** O teste verifica quais agentes exigem inspeção de configuração manual ou hooks específicos; o `agy` foi adicionado à lista retornada, mas a asserção esperava apenas `['cursor', 'kiro']`.
- **Como resolver:** Ajustar a expectativa para incluir `'agy'`.

### 6. `src/services/agents/runtime/live/hookLifecycle.config.test.ts`
- **Teste:** `real CLI scenarios cover every hook Cate installs`
- **Erro:** `TypeError: Cannot convert undefined or null to object`
- **Causa:** O fixture de cenários em tempo real (`hookLifecycle`) tenta iterar sobre a configuração de hooks para cada CLI registrado em `AGENTS`. Como o `agy` ainda não tem um objeto de cenário definido no fixture, o teste quebra com `TypeError`.
- **Como resolver:** Definir o cenário mock/fixture do `agy` em `src/services/agents/runtime/live/hookLifecycle.config.ts`.

### 7. `src/services/agents/runtime/live/hookSmoke.config.test.ts`
- **Teste:** `live hook CI coverage > every supported CLI is installed and tested by the matrix`
- **Erro:** `AssertionError: expected [ 'claude-code', 'codex', …(4) ] to deeply equal [ 'agy', 'claude-code', 'codex', …(4) ]`
- **Causa:** O teste de CI garante que todo CLI registrado possui um job/smoke test configurado. Falta a entrada de `'agy'`.
- **Como resolver:** Adicionar `'agy'` na configuração do smoke test.

### 8. `src/services/agents/runtime/usage/usage.test.ts`
- **Teste:** `workspace usage > counts every agent CLI's sessions that ran in the workspace or its worktrees`
- **Erro:** `AssertionError: expected { 'claude-code': [ 'ok', 2 ], …(6) } to deeply equal { ... (5) }`
- **Causa:** A expectativa de contagem de sessões no teste de métricas/usage esperava 5 tipos de agentes, mas agora são 6 (com o `agy`).
- **Como resolver:** Incluir o `agy` na fixture de contagem esperada.

---

## Próximos passos recomendados (para quando formos trabalhar nisso)
1. **Passo 1 (Testes unitários simples):** Atualizar as listas esperadas em `start.test.ts`, `status.integration.test.ts`, `agentHooks.test.ts` e `usage.test.ts`.
2. **Passo 2 (Step parser do Agy):** Ajustar o mapeamento de tool calls do `agy` para produzir os passos no terminal (`terminal.test.ts`).
3. **Passo 3 (Live test fixtures):** Adicionar o objeto de cenário do `agy` em `hookLifecycle.config.ts` e `hookSmoke.config.ts`.
