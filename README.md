# Cate — Versão derivada para orquestração de agentes

Versão derivada do [Cate, projeto open source de 0-AI-UG](https://github.com/0-AI-UG/cate), com funcionalidades e ajustes desenvolvidos por **Cauã Azevedo Santos**, com apoio de ferramentas de inteligência artificial.

O Cate original fornece um ambiente de trabalho com terminais, editores, navegador e agentes de programação em um canvas. Este repositório evolui essa base com foco na configuração e no uso de múltiplos agentes.

## Alterações desta versão

| Área | Funcionalidade ou melhoria | Registro |
| --- | --- | --- |
| Antigravity | Inclusão do agente `agy`, leitura de sessões e integração com eventos do seu ciclo de execução. | [Integração](https://github.com/i-am-caua/Cate/commit/711aff9ccc09700aa31be2f28082f24dc3f9ebda) · [Ajustes e testes](https://github.com/i-am-caua/Cate/commit/1aad66bb7ec3efa2795e329484f606206ded42ce) |
| Configuração visual | Prévia em diagrama das configurações de agentes, com papéis, relações e seleção de modelo e nível de esforço nos agentes compatíveis. | [Implementação](https://github.com/i-am-caua/Cate/commit/972abaf063bcc47c4accd6f2fa6b6f57ed8534e2) |
| Fluxo de execução | Inicialização dos agentes auxiliares antes do orquestrador e envio dos identificadores dos painéis no contexto da tarefa. | [Correção](https://github.com/i-am-caua/Cate/commit/6386b55bdf451eaf0ef5e0a2bd7ab39abfbf21fd) |
| Alethe | Inclusão da Skill Alethe e de configurações de orquestração; ajustes na exportação e no reaproveitamento de sessões. | [Inclusão](https://github.com/i-am-caua/Cate/commit/972abaf063bcc47c4accd6f2fa6b6f57ed8534e2) · [Pull request](https://github.com/i-am-caua/Cate/pull/1) |

Essas alterações fazem parte desta versão derivada. A base do aplicativo, os recursos anteriores e suas respectivas autorias pertencem ao histórico do projeto original e de seus colaboradores.

## Exemplo de uso

Um fluxo de trabalho é preparar uma equipe de agentes, revisar seu diagrama, escolher modelos compatíveis e informar uma tarefa ao orquestrador. Os agentes auxiliares são criados antes do início dessa tarefa, permitindo que o orquestrador receba os identificadores reais dos painéis.

O repositório contém um [exemplo de configuração para planejar e executar em etapas](skills/alethe/assets/setups/base-plan-big-execute-small.json) e [orientações da integração Alethe com o Cate](skills/alethe/references/cate.md).

## Desenvolvimento com apoio de IA

Uso agentes e ferramentas de IA para apoiar a implementação e a evolução das funcionalidades. Os links acima permitem acompanhar as mudanças no código, os testes adicionados e o histórico de revisão.

A presença de testes no repositório não significa que todas as verificações estejam aprovadas. O estado de cada execução pode ser consultado em [Actions deste repositório](https://github.com/i-am-caua/Cate/actions).

## Executar esta versão

O ambiente de desenvolvimento utiliza **Bun** e **Node.js 20 ou 22 LTS**. No Linux, a compilação de dependências nativas também requer Python 3 e uma ferramenta de compilação C++.

```bash
git clone https://github.com/i-am-caua/Cate.git
cd Cate
bun run setup
bun run dev
```

Os agentes externos precisam estar instalados e configurados para uso no ambiente. Consulte [CONTRIBUTING.md](CONTRIBUTING.md) para os requisitos completos e o funcionamento do runtime.

Os instaladores distribuídos pelo projeto original correspondem à versão original; para experimentar as alterações descritas aqui, utilize este código-fonte.

## Verificações disponíveis

```bash
bun run typecheck
bun run lint
bun run lint:deps
bun run test
bun run build
```

Há também testes de integração e de eventos dos agentes. Consulte os scripts em [package.json](package.json) para os comandos e os requisitos de cada suíte.

## Créditos e licença

- **Projeto original:** [0-AI-UG/cate](https://github.com/0-AI-UG/cate).
- **Contribuições destacadas nesta versão:** [i-am-caua](https://github.com/i-am-caua), com assistência de IA.
- **Demais contribuições:** registradas no [histórico de commits](https://github.com/i-am-caua/Cate/commits/main/) e na [lista de colaboradores](https://github.com/i-am-caua/Cate/graphs/contributors).
- **Licença:** [MIT](LICENSE), com preservação dos avisos e créditos do projeto original.

A documentação e a apresentação da versão original estão disponíveis no [repositório de origem](https://github.com/0-AI-UG/cate#readme).
