# Sales Enablement — Make Vendas

Avalia as calls dos closers contra o playbook comercial e entrega análise, painel, relatório diário e alertas. Especificação completa em [SPEC.md](SPEC.md).

**Status:** Fases 1 (ingestão + métricas), 2 (análise IA), 3 (painel) e 4 (relatórios, alertas, calibração, insights e custos) concluídas. Próxima: integração com o CRM e servidor MCP (Fase 5).

## Setup

```bash
corepack enable          # habilita o pnpm
pnpm install
cp .env.example .env
```

Requisitos: Node 24+, `ffmpeg`/`ffprobe` (duração dos vídeos) e **Claude Code** instalado e logado (versão 2.1.280+).

### Motor de IA

- `LLM_PROVIDER=claude-cli` (padrão): usa o Claude Code em modo headless (`claude -p`) e **consome a assinatura do Claude**, sem créditos de API. Roda com contexto mínimo (prompt próprio, sem ferramentas, MCP, settings ou skills). O custo registrado é o **equivalente** em API, marcado como `assinatura`. Limites: a cota da assinatura e uma chamada por vez (sem Batch API).
- `LLM_PROVIDER=api`: Claude API com `ANTHROPIC_API_KEY` (créditos pagos), com prompt caching; é o caminho para produção/CRM.

O binário do Claude Code é achado sozinho (a versão mais nova entre o PATH, `~/.local/bin` e a extensão do VS Code); `CLAUDE_CLI_PATH` força um caminho.

## Comandos

| Comando | O que faz |
|---|---|
| `pnpm ingest` | Lê `data/inbox/`, normaliza as transcrições, identifica papéis, faz a triagem e calcula as métricas. Mostra a tabela de todas as calls. |
| `pnpm ingest --force` | Reprocessa calls já ingeridas (por padrão, hash igual = não reprocessa). |
| `pnpm ingest --no-llm` | Não chama a API: triagem e papéis por heurística. |
| `pnpm ingest --yes` | Confirma lotes com mais de 10 calls (a estimativa de custo é mostrada antes). |
| `pnpm analyze --call <id>` | Analisa uma call em cada playbook ativo. |
| `pnpm analyze --all` | Analisa todas as calls comerciais (acima de 3 análises pede `--yes`, depois de mostrar a estimativa). |
| `pnpm analyze … --playbook <id>` | Só um playbook. |
| `pnpm analyze … --force` | Refaz análises existentes (mesma call × playbook × versão do prompt). |
| `pnpm reclassify [--dry-run]` | Recalcula ok / atenção / crítica das análises salvas com as regras atuais do `config/rules.yaml`, sem chamar a IA (custo zero). |
| `pnpm alerts [--call <id>]` | Gera os alertas (crítica / churn vermelho) de análises já salvas. O `pnpm analyze` já alerta sozinho; isto é para análises antigas. Não repete alerta. |
| `pnpm report:daily [--date AAAA-MM-DD] [--gestor <id>] [--playbook <id>] [--force]` | Relatório diário de cada gestor (padrão: hoje). `--force` gera de novo o daquele dia. |
| `pnpm calibrate --template` | Gera `data/calibracao.template.csv` para a avaliação humana (sem a resposta da IA). |
| `pnpm calibrate [--file data/calibracao.csv]` | Importa a avaliação humana, compara com a IA e grava `out/calibracao/relatorio-<data>.md`. |
| `pnpm calibrate --estabilidade [--calls a,b] [--rodadas 2] [--yes]` | Reanalisa calls sem tocar na análise oficial e mede a variação da nota (consome cota; mostra a estimativa e pede `--yes`). |
| `pnpm export:analyses [--call <id>]` | Exporta as análises verificadas para `out/analises/*.json` (revisão). |
| `pnpm dev` | Painel em http://localhost:3000. Sem `?playbook=`, abre no playbook com mais calls analisadas. |
| `pnpm test` | Testes (Vitest). |
| `pnpm typecheck` | Checagem de tipos. |
| `pnpm db:generate` | Gera migração após mudar `src/core/db/schema.ts`. |

## Entrada de dados

```
data/inbox/        # solte aqui transcrições (.txt, .vtt, .srt, .json) e vídeos com o mesmo nome base
data/processed/    # transcrição normalizada (JSON canônico por call)
data/media/        # vídeos disponibilizados para o player
data/app.db        # banco SQLite
```

- Transcrição e vídeo são pareados pelo nome do arquivo (`Reunião-01-Eli.txt` + `Reunião-01-Eli.webm`).
- Sem `manifest.csv`, o `call_id` e o closer são inferidos pelo nome do arquivo (alias em `config/team.yaml`).
- Todo `pnpm ingest` gera `data/inbox/manifest.sugerido.csv` com o que já se sabe. Complete (desfecho, produto, tipo_call…), salve como `manifest.csv` e rode `pnpm ingest` de novo: os metadados são atualizados **sem reprocessar** a call. Campos vazios no manifest não apagam o que já está no banco.
- Idempotência por hash do arquivo: conteúdo repetido com outro nome é marcado como duplicata e ignorado.
- Call só com vídeo é ignorada por enquanto (transcrição por whisper desativada).

### Como a ingestão trata as transcrições

- **Papéis:** closer pelo `team.yaml` (o closer do time com mais fala); outras pessoas da Make viram `outro` pelo modo como se apresentam ("aqui da Make", "nosso closer") ou pelo LLM; o resto é `cliente`.
- **Triagem:** regras em código primeiro (sem cliente, duração efetiva abaixo do mínimo → `nao_comercial`); depois `LIGHT_MODEL` confirma se é call comercial e revisa os papéis. Sem chave de API, fica `comercial (heuristica)`.
- **Bastidor:** o que vem antes da primeira fala do lead (espera, conversa interna) é marcado e fica fora das métricas.
- **Ruído:** trechos repetitivos de transcrição automática (poucos trigramas distintos) ficam fora das métricas.
- **Tempo:** sem timestamps, a duração do vídeo é distribuída proporcionalmente às palavras de cada fala e as métricas de tempo ficam marcadas `tempo_estimado`.

## Análise (Fase 2)

Uma chamada estruturada por call × playbook (`prompts/analysis.v1.md`, modelo `ANALYSIS_MODEL`, esforço `high`). Depois, em código:

1. **Verificação de evidências:** toda citação precisa existir na fala indicada (similaridade ≥ 0,85, tolerância de ±2 falas, inclusive atravessando duas falas seguidas). Bastidor e ruído não valem. Citação não encontrada é descartada e registrada (`evidences.valida = false`) — a taxa de descarte é a métrica de qualidade do prompt.
2. **Rebaixamento:** etapa sem evidência válida vira `ausente` (nota 0); no SPICED (`evidencia_do_lead_obrigatoria`), `completo` sem nenhuma fala do lead vira `parcial` (nota máx. 6). Risco de churn citando fala do lead é descartado. "Quem quantificou" o custo da inação é corrigido pelo papel real do falante.
3. **Nota de aderência** recalculada em código (média ponderada das etapas × 10). A nota que o modelo deu fica em `nota_llm`.
4. **Classificação** `ok | atencao | critica` com motivos, pelos critérios de `config/rules.yaml`.
5. Tudo gravado com modelo, versão do prompt e do playbook, tokens e custo.

**Consistência:** o modelo de análise não aceita `temperature`; a estabilidade vem de critérios objetivos, saída estruturada e das regras em código. O teste de estabilidade (reanalisar 5 calls duas vezes; variação > 10 pontos = apertar critérios) é o `pnpm calibrate --estabilidade`. A triagem usa `temperature: 0` quando roda pela API.

**Limitação atual:** com `config/products.yaml` vazio, risco de funcionalidade inexistente ou condição fora da política sai no máximo como amarelo, e cada análise registra essa limitação.

## Painel (Fase 3)

- **`/calls`** — lista com filtros (playbook, closer, status, desfecho, produto, churn) na URL, então dá para mandar o link filtrado. Colunas: data, closer, lead, produto, nota, chips das etapas, % de fala, duração, desfecho, status e flags de churn.
- **`/calls/[id]`** — nota, status e **por que está crítica, com as citações de risco clicáveis**; desfecho editável (não reanalisa); seletor de playbook; linha do tempo de quem falou com marcadores de etapas, objeções e churn; insight de coaching em destaque; etapas com evidências, o que faltou e pergunta sugerida; riscos de churn com "como deveria ter dito"; objeções, reframe, custo da inação, cases; resumo; próximos passos com checkbox; mapa mental (Mermaid); vídeo + transcrição sincronizados (clicar numa citação rola a transcrição e posiciona o vídeo; com tempo estimado, o salto é aproximado).
- **`/closers/[id]`** — % abaixo da barra, nota média, fala, perguntas, conversão, evolução da nota, cobertura por etapa e os temas de coaching mais recorrentes.
- **`/time`** — visão do gestor: % de calls abaixo da barra por closer (métrica principal), etapa em que o time mais falha, ranking, calls críticas e com churn vermelho (todo o período ou 7 dias).

- **`/insights`** — a nota prevê a venda? Conversão por faixa de nota, por etapa completa vs. não, reframe, custo da inação e case (a pedido vs. proativo); AUC e correlação; SPICED × Make nas mesmas calls. Só entram calls com desfecho ganho/perdido; todo grupo mostra o n e os com menos de 30 calls aparecem apagados.
- **`/custos`** — custo por call, dia, closer, etapa e modelo; tokens sem cache, cache escrito e cache lido; custo real de API separado do equivalente da assinatura.
- **`/notificacoes`** — central de alertas e relatórios diários (sino no cabeçalho com as não lidas).

**Permissões:** sem login na V1; o viewer vem de `VIEWER_ID` (padrão `victor`, admin). As consultas em `src/core/queries.ts` já filtram por escopo — gestor vê o time dele, closer só as próprias calls — e são as mesmas que o futuro servidor MCP vai usar.

**Tema** claro/escuro (segue o sistema; alterna no cabeçalho). O vídeo é servido por `/api/media/[id]` com suporte a Range.

## Relatórios, alertas e calibração (Fase 4)

**Canais.** Toda notificação é uma mensagem estruturada formatada por canal: painel (sempre ativo), Slack (Incoming Webhook, Block Kit, menciona o `slack` do `team.yaml`) e WhatsApp (interface pronta; o provedor ainda não foi definido, então o envio real dá erro claro).

**Dry-run.** Com `NOTIFY_DRY_RUN=true` (padrão), nada sai da máquina: cada canal grava o que enviaria em `out/notifications/<data>/` (`.txt` para painel e WhatsApp, `.json` com os blocks do Slack) e a mensagem aparece na central do painel.

**Alerta imediato.** Ao terminar uma análise crítica ou com churn vermelho, cada gestor do closer recebe um alerta (sem gestor, os admins). É um por call × gestor: reanalisar ou analisar no outro playbook não repete. O `reclassify` nunca alerta.

**Relatório diário.** Por gestor e só com o time dele: nº de calls do dia, nota média, % abaixo da barra, etapa mais fraca, até 3 calls para olhar primeiro (churn vermelho e menor nota), próximos passos vencidos (de qualquer dia). O dia da call é `data_hora` (manifest) ou, sem ela, o dia da ingestão. Prazos são texto livre: só viram data quando é claro ("hoje", "amanhã", "sexta", "dia 7", "fim da semana", "em 10 dias", datas); com mais de um prazo vale o mais tardio; vago ou condicional ("sem prazo", "depois que o material chegar") conta como sem prazo.

**Agendamento (cron local).** `crontab -e` e adicione (dias úteis às 19h):

```cron
0 19 * * 1-5 cd ~/Documents/TRAMPOS/MAKE-Sales-Enablement && PATH=$HOME/.nvm/versions/node/v24.15.0/bin:$PATH pnpm report:daily >> out/report-daily.log 2>&1
```

O cron não roda com o Mac dormindo; se o horário passar, rode `pnpm report:daily --date <dia>` depois.

**Calibração.** `pnpm calibrate --template`, preencha a coluna `avaliacao` (`completo | parcial | ausente`; na linha `risco_de_churn`, `sim | nao`), salve como `data/calibracao.csv` e rode `pnpm calibrate`. O relatório traz concordância por etapa (exata, completo vs. não, kappa), se a IA é mais generosa ou mais rígida que você, concordância de churn e as divergências com a citação que a IA usou. Reimportar substitui as avaliações; linhas em branco são ignoradas.

## Variáveis de ambiente

| Variável | Uso |
|---|---|
| `LLM_PROVIDER` | `claude-cli` (assinatura, padrão) ou `api`. |
| `CLAUDE_CLI_PATH` | Opcional: caminho do binário do Claude Code. |
| `ANTHROPIC_API_KEY` | Chave da Claude API (só com `LLM_PROVIDER=api`). |
| `ANALYSIS_MODEL` | Modelo da análise principal (padrão `claude-opus-5-5`). |
| `LIGHT_MODEL` | Modelo das tarefas leves: triagem e papéis (padrão `claude-haiku-4-5`). |
| `USD_BRL` | Câmbio para registrar custo em reais. |
| `DATABASE_PATH` | Caminho do SQLite local (padrão `data/app.db`). |
| `VIEWER_ID` | Quem está vendo o painel (id do `team.yaml`; padrão `victor`). |
| `DATABASE_URL` / `DATABASE_AUTH_TOKEN` | Opcional: banco libSQL hospedado (Turso), para subir o painel depois. |
| `MASK_PII` | `true` mascara CPF/CNPJ, telefone, e-mail e cartão antes de enviar à API. |
| `PANEL_URL` | Endereço do painel usado nos links das mensagens (padrão `http://localhost:3000`). |
| `SLACK_WEBHOOK_URL` | Incoming Webhook do Slack (só vale com `NOTIFY_DRY_RUN=false`). |
| `NOTIFY_DRY_RUN` | `true` (padrão): notificações só em `out/notifications/` e no painel. |

Custo de cada chamada fica em `cost_log` (tokens com e sem cache, US$ e R$).

## Configuração

- `config/team.yaml` — pessoas, papéis, gestores, aliases e contatos.
- `config/rules.yaml` — limiares (duração mínima, ruído, barra mínima, talk ratio, critérios de call crítica).
- `config/products.yaml` — o que cada produto entrega e **não** entrega (base para risco de churn).
- `config/playbooks/*.yaml` — playbooks de avaliação.

### Adicionar um playbook

Crie `config/playbooks/<id>.yaml` com a estrutura:

```yaml
id: meu-playbook
nome: Meu Playbook
versao: 1
etapas:
  - id: etapa_1
    nome: Etapa 1
    objetivo: ...
    completo_quando: ...
    parcial_quando: ...
    sinais_de_evidencia: [...]
    perguntas_exemplo: [...]
    peso: 1
```

Mude `versao` sempre que alterar critérios — a versão é gravada junto com cada análise.

## Arquitetura

- `src/core/` — domínio puro (sem Next): tipos, parsers, normalização, métricas, triagem, análise (`analysis/`), provedores de IA (`llm/`), banco, origem de dados. É o que será reaproveitado na integração com o CRM.
  - `sources/` — interface `CallSource`; hoje `LocalFolderSource`, depois `CrmSource`.
- `src/cli/` — comandos (`tsx`).
- `src/app/` — painel (Fase 3).
- `prompts/` — prompts versionados.
- `drizzle/` — migrações (SQLite/libSQL, schema compatível com Postgres).

## Nota sobre o caminho

Não coloque o projeto num caminho com `#`: Vite/Vitest, Turbopack, webpack e o Tailwind tratam `#` como fragmento de URL e quebram (por isso o projeto saiu de `…/#MAKE/…`).

## Privacidade

`data/`, `out/` e `.env` estão no `.gitignore`. Testes usam só fixtures sintéticas.
