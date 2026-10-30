# Super prompt — Call Intelligence Make Vendas (V1 local, pós-call)

> Cole este documento inteiro no Claude Code (ou salve como `SPEC.md` na raiz do projeto e diga: "Leia SPEC.md e execute a Fase 0").

---

## 1. Missão

Você vai construir o **Call Intelligence da Make Vendas**: um sistema que ingere as reuniões dos closers (transcrição + vídeo exportados do nosso CRM), avalia cada call contra o playbook comercial com IA e entrega:

- análise completa de cada call (aderência ao playbook, métricas de conversa, objeções, risco de churn, resumo, próximos passos, coaching);
- painel para closer, gestor e admin;
- relatório diário e alertas de call crítica para os gestores (painel, Slack e WhatsApp).

**Escopo da V1: só pós-call.** Nada de copiloto ao vivo nem extensão do Google Meet.
**Ambiente da V1: local.** Eu baixo as reuniões e transcrições do CRM e coloco numa pasta. Depois vamos integrar direto no nosso CRM, então a origem dos dados precisa ser um adapter trocável.

## 2. Contexto do negócio

- **Empresa:** Make Vendas (Make Máquina de Vendas), plataforma de marketing e vendas digitais, operação em 6 países, +5.000 clientes.
- **Produtos que os closers vendem (confirme comigo):** Make ADS, MakeCRM, Kit de Autoridade Digital, Mavi, Acelerador de Lucros.
- **Usuários:** eu (Victor, Diretor de Operações, admin), gestores comerciais e closers.
- **Idioma:** tudo em português do Brasil (UI, análises, mensagens). Se aparecer call em espanhol, mantenha as citações no idioma original e a análise em PT-BR.

## 3. Princípios (são requisitos, não sugestões)

1. **Aderência ao playbook é piso, não teto.** Quem segue o playbook "nota 7" converte praticamente igual a quem tira 10; o ganho real está em tirar gente da faixa ruim. O sistema deve destacar quem está **abaixo da barra mínima**, não perseguir nota 10.
2. **Um insight por vez.** Coaching com no máximo 3 pontos, ordenados por prioridade; o primeiro aparece em destaque.
3. **Sem evidência, não conta.** Toda afirmação da IA sobre a call precisa de citação literal + posição na transcrição. Etapa sem evidência válida não é "completa".
4. **Medir o que é controlável.** Além do playbook, medir hipóteses que movem conversão: Reframe (reposicionar a dor do lead), quantificação do custo de não resolver, case mostrado a pedido vs. proativamente.
5. **Detectar churn na origem.** Promessa do closer que depois vira frustração e cancelamento é um alerta, não um detalhe.
6. **Validar antes de confiar.** A nota só vale se tiver relação com conversão real. Se a gente converte igual sem seguir o playbook, o problema é o playbook — o sistema tem que mostrar isso.
7. **Custo visível.** Tokens e custo registrados por call; nada de processar lote grande sem estimativa.
8. **Não inventar regra comercial.** Faltou informação de negócio (playbook, promessas proibidas, política comercial), pergunte.

## 4. Stack padrão

Use isto, a não ser que tenha um motivo forte (se mudar, me explique antes):

- **Um projeto Next.js (App Router) + TypeScript**, com pnpm.
  - `src/core/` — domínio puro, sem dependência de Next: tipos, schemas Zod, parsers, métricas, pipeline de análise, regras, notifiers. É o que vamos reaproveitar na integração com o CRM.
  - `src/cli/` — comandos via `tsx` (ingest, analyze, report, calibrate).
  - `src/app/` — painel.
- **UI:** Tailwind + shadcn/ui + Recharts. Mermaid para o mapa mental.
- **Banco:** SQLite com Drizzle ORM, schema compatível com Postgres.
- **IA:** Anthropic SDK (Claude API).
  - Modelos em variáveis de ambiente: `ANALYSIS_MODEL` (análise principal) e `LIGHT_MODEL` (tarefas leves: triagem, papel dos falantes). Consulte a documentação atual para os IDs — não chute nome de modelo.
  - Saída estruturada via tool use / JSON schema, validada com Zod. Temperatura 0.
  - Prompt caching no bloco fixo (instruções + playbook + regras).
  - Message Batches API para reprocessar histórico.
- **Vídeo (opcional):** ffmpeg para extrair áudio; `faster-whisper` só como fallback quando a call não tiver transcrição.
- **Testes:** Vitest.

## 5. Entrada de dados

```
data/
  inbox/            # eu solto aqui o que baixei do CRM
    manifest.csv    # opcional, recomendado
  processed/        # transcrição normalizada (JSON canônico)
  media/            # vídeos, servidos no painel para o player
out/
  notifications/    # mensagens geradas em dry-run
```

**`manifest.csv`** (colunas): `call_id, transcricao, video, closer, gestor, data_hora, lead_nome, empresa, produto, tipo_call, desfecho, valor_venda, crm_url, obs`

- `tipo_call`: diagnostico | fechamento | follow_up | outro
- `desfecho`: ganho | perdido | em_andamento | no_show
- Sem manifest: tente inferir pelo nome do arquivo e deixe os campos faltantes editáveis no painel.
- O **desfecho muda depois da call** e é essencial para a análise de conversão: permitir atualizar (reimportando o manifest ou editando no painel) **sem reanalisar** a call.
- Idempotência por hash do arquivo: nunca reprocessar a mesma call sem eu pedir.

**Formatos:** não sei exatamente o que o CRM exporta. **Antes de escrever qualquer parser, abra as amostras em `data/inbox/` e me reporte** o formato, se há falante identificado, se há timestamps e a qualidade da transcrição. Depois crie parsers para o que existir (txt "Nome: fala", .vtt, .srt, .json, .docx), normalizando para:

```ts
type Segment = {
  idx: number;
  speaker: string;
  role: 'closer' | 'cliente' | 'outro';
  start?: number; // segundos
  end?: number;
  text: string;
};
```

- Papel de cada falante: primeiro pelo nome/aliases do closer em `config/team.yaml`; se ambíguo, uma passada com `LIGHT_MODEL`.
- Sem timestamps: estimar pela contagem de palavras e marcar as métricas de tempo como `estimado`.
- Só vídeo: transcrever com faster-whisper, atribuir falantes via LLM e marcar métricas como `estimado`.

## 6. Configuração (arquivos versionados)

- `config/team.yaml` — pessoas, papel (admin | gestor | closer), gestor de cada closer, aliases de nome (como aparecem na transcrição), telefone WhatsApp e usuário Slack do gestor. Seed inicial de closers: Elisangela, Jéssica, Luã — **confirme comigo e complete**.
- `config/products.yaml` — por produto: o que entrega, prazos reais, o que **não** entrega. É a base para detectar promessa indevida.
- `config/playbooks/spiced.yaml`
- `config/playbooks/make-closer.yaml`
- `config/rules.yaml` — limiares: barra mínima de aderência, talk ratio máximo do closer, definição de call crítica, severidade de churn, duração mínima para analisar.

### 6.1 Formato do playbook

```yaml
id: spiced
nome: SPICED
versao: 1
etapas:
  - id: situacao
    nome: Situação
    objetivo: ...
    completo_quando: ...
    parcial_quando: ...
    sinais_de_evidencia: [...]
    perguntas_exemplo: [...]
    peso: 1
```

### 6.2 SPICED (semente — refine comigo)

| Etapa | Completo quando | Parcial quando |
|---|---|---|
| **Situação** | O lead deu pelo menos 2 respostas substantivas sobre o contexto: modelo de negócio, tamanho, faturamento/meta, canais de aquisição, time comercial, ferramentas atuais | Contexto superficial ou só o closer descreveu |
| **Dor** (Pain) | Problema específico **e** causa raiz, nas palavras do lead | Dor genérica ("quero vender mais") sem causa |
| **Impacto** | O **lead** verbalizou consequência concreta ou número (R$, leads, vendas, contratações, tempo), idealmente o custo de não resolver | Impacto sugerido pelo closer e só confirmado com "sim" |
| **Evento Crítico** | Prazo **com** consequência: até quando precisa resolver e o que acontece se não resolver | Prazo sem consequência, ou "o quanto antes" |
| **Decisão** | Decisores, critérios de decisão, processo/próximo passo e orçamento ou alternativas avaliadas | Só parte disso |

Regra geral: o que conta é o que o **lead** disse. Afirmação do closer que o lead não confirmou com conteúdo próprio não completa etapa.

### 6.3 Playbook da Make

> **[COLE AQUI O PLAYBOOK DE CLOSER DA MAKE — etapas, perguntas obrigatórias, objeções comuns e como responder]**

Se eu ainda não tiver colado quando você chegar nessa parte, crie `make-closer.yaml` com a mesma estrutura, marque como `TODO` e me pergunte. Não invente o roteiro.

### 6.4 Dois playbooks na fase de teste

Cada call é avaliada **nos dois playbooks** (uma análise por call × playbook). O painel tem seletor de playbook, e a tela de insights compara qual das duas notas se relaciona melhor com o desfecho real.

## 7. Pipeline por call

1. **Ingestão** → normalização → segments → papel dos falantes.
2. **Triagem** (`LIGHT_MODEL`): é call comercial com lead? Treinamento, entrevista, daily, no-show ou call abaixo da duração mínima são marcadas `nao_comercial` e **não recebem nota**.
3. **Métricas determinísticas (em código, não LLM):**
   - % de fala closer vs. cliente (por tempo; fallback por palavras);
   - maior monólogo do closer;
   - nº de perguntas do closer e do cliente (heurística; o LLM depois separa abertas vs. fechadas);
   - duração total.
4. **Análise LLM** (`ANALYSIS_MODEL`, uma chamada estruturada por call × playbook). Saída validada com Zod:

```ts
{
  playbook_id: string;
  etapas: Array<{
    id: string;
    status: 'completo' | 'parcial' | 'ausente';
    nota_0a10: number;
    evidencias: Array<{ citacao: string; segment_idx: number }>;
    o_que_faltou: string;
    pergunta_sugerida: string;
  }>;
  nota_aderencia_0a100: number;
  perguntas_closer: { abertas: number; fechadas: number };
  objecoes: Array<{
    tipo: 'preco' | 'tempo' | 'confianca' | 'decisor' | 'concorrente' | 'necessidade' | 'outro';
    citacao: string; segment_idx: number;
    tratamento: string; resolvida: boolean;
  }>;
  reframe: { ocorreu: boolean; dor_original?: string; dor_reposicionada?: string; citacao?: string; segment_idx?: number; qualidade_0a3: number };
  custo_da_inacao: { quantificado: boolean; quem_quantificou?: 'lead' | 'closer'; valor?: string; citacao?: string; segment_idx?: number };
  cases: { cliente_pediu: boolean; closer_mostrou: boolean; momento: 'a_pedido' | 'proativo' | null };
  sentimento_cliente: {
    geral: 'entusiasmado' | 'interessado' | 'neutro' | 'resistente' | 'desinteressado';
    sinais_de_compra: string[];
    momentos: Array<{ segment_idx: number; sentimento: string; citacao: string }>;
  };
  risco_churn: Array<{
    severidade: 'amarelo' | 'vermelho';
    tipo: 'promessa_de_resultado' | 'prazo_irreal' | 'funcionalidade_inexistente' | 'expectativa_desalinhada' | 'condicao_fora_da_politica' | 'outro';
    citacao: string; segment_idx: number;
    por_que_e_risco: string;
    como_deveria_ter_dito: string;
  }>;
  resumo: {
    contexto: string;
    dores: string[];
    impacto_financeiro: { descricao: string; valores: string[] };
    evento_critico: string;
    decisao: { decisores: string[]; criterios: string[]; processo: string; alternativas_avaliadas: string[] };
  };
  proximos_passos: Array<{ responsavel: string; tarefa: string; prazo?: string; citacao?: string }>;
  coaching: {
    pontos_fortes: string[];                                  // máx. 3
    melhorias: Array<{ ponto: string; exemplo_de_frase: string }>; // máx. 3, por prioridade
  };
  mapa_mental_mermaid: string;
  confianca: 'alta' | 'media' | 'baixa';
  observacoes: string;
}
```

5. **Verificação de evidências (em código):** toda `citacao` precisa existir no segmento indicado (fuzzy match ≥ 0,85, com tolerância a ±2 segmentos). Citação não encontrada é descartada; etapa que fica sem evidência válida é rebaixada. Registre quantas citações foram descartadas por call — é a métrica de qualidade do prompt.
6. **Classificação (em código, via `rules.yaml`):** `ok` | `atencao` | `critica`, sempre com a lista de motivos. Defaults (configuráveis): crítica se nota < barra mínima, **ou** churn vermelho, **ou** closer falou > 65%, **ou** nenhuma etapa completa.
7. **Persistência:** tudo no banco, incluindo `model`, `prompt_version`, `playbook_version`, tokens (entrada, saída, cache) e custo em USD e BRL (`USD_BRL` no `.env`).

### 7.1 Diretrizes para o prompt de análise (`prompts/analysis.v1.md`)

- Versionado em arquivo; a versão vai junto com cada resultado.
- Papel: analista de enablement comercial rigoroso, que só afirma o que está na transcrição.
- Separar sempre o que o **lead** disse do que o **closer** disse.
- Não deduzir números, prazos ou decisores que não foram falados.
- Churn: comparar o que o closer prometeu com `products.yaml`. Exemplos de risco (confirme comigo e complete): garantir número de leads/vendas ou ROI, prometer prazo de resultado, citar funcionalidade que não existe, "você não vai precisar fazer nada", condição comercial fora da política.
- Coaching acionável: cada melhoria vem com uma frase que o closer poderia ter usado naquele momento da call.

## 8. Banco (mínimo)

`people`, `calls`, `segments`, `analyses` (call × playbook × prompt_version), `stage_results`, `evidences`, `objections`, `churn_flags`, `next_steps` (com status pendente/feito editável), `notifications`, `cost_log`, `calibration_labels`.

## 9. Painel

Visual limpo e denso em informação, PT-BR, claro/escuro, responsivo.

1. **`/calls`** — lista com filtros (período, closer, produto, desfecho, status, com churn, playbook). Colunas: data, closer, lead, produto, nota, chips das etapas (verde/amarelo/cinza), % fala, desfecho, flags.
2. **`/calls/[id]`**
   - Cabeçalho: nota, status + motivos, desfecho (editável).
   - Chips das etapas; ao clicar, evidências + o que faltou + pergunta sugerida.
   - Resumo estruturado (contexto, dores, impacto em R$, evento crítico, decisão).
   - Próximos passos com checkbox.
   - Coaching: um insight em destaque, depois os demais.
   - Objeções, riscos de churn (com "como deveria ter dito"), reframe, custo da inação, cases.
   - Timeline da conversa: faixas de quem falou + marcadores de etapas, objeções e churn.
   - Transcrição com os trechos de evidência destacados. Se houver vídeo, player sincronizado: clicar na citação pula para o momento.
   - Mapa mental (Mermaid).
3. **`/closers/[id]`** — evolução da nota no tempo, cobertura média por etapa, % fala, perguntas por call, conversão, calls críticas, os 3 temas de coaching mais recorrentes.
4. **`/time`** (visão do gestor) — **% de calls abaixo da barra mínima por closer (métrica principal)**, etapa em que o time mais falha, ranking, calls com churn da semana, calls críticas para revisar.
5. **`/insights`** — o que valida o sistema:
   - nota de aderência em quintis × taxa de conversão (mostrando o n de cada faixa);
   - conversão com cada etapa completa vs. não;
   - reframe sim/não, custo da inação quantificado sim/não e case a pedido vs. proativo × conversão;
   - SPICED vs. playbook Make: qual nota prediz melhor o desfecho;
   - aviso explícito quando a amostra for pequena para conclusão (ex.: n < 30 por grupo). Correlação não é certeza — deixe isso claro na tela.
6. **`/custos`** — custo por call, por dia e por closer; tokens com e sem cache.

**Permissões:** na V1 local não há login (só eu). Mas modele papéis e escopo nas queries desde já (gestor vê só o time dele; closer só as próprias calls), para quando formos para o CRM.

## 10. Relatórios e alertas

- **`pnpm report:daily`** — por gestor: nº de calls, nota média, % abaixo da barra, etapa mais fraca do time, top 3 calls para olhar (críticas/churn) com link do painel, próximos passos vencidos.
- **Alerta imediato** quando uma análise termina como `critica` ou com churn vermelho.
- **Canais** via interface `Notifier`:
  - `PanelNotifier` — sempre ativo; central de notificações no painel.
  - `SlackNotifier` — Incoming Webhook, mensagem em Blocks.
  - `WhatsAppNotifier` — **me pergunte qual provedor usamos** antes de implementar; deixe a interface pronta. Mensagem curta, sem markdown pesado.
- **`NOTIFY_DRY_RUN=true` por padrão:** grava as mensagens em `out/notifications/` e mostra no painel. Nada sai para Slack/WhatsApp até eu ligar.
- Agendamento via cron local (documente no README), sem serviço externo.

## 11. Privacidade (LGPD)

- `data/`, `out/` e `.env` no `.gitignore`.
- `MASK_PII=true` (opcional): mascarar CPF/CNPJ, telefone, e-mail e cartão antes de enviar para a API.
- Nenhum dado sai para outro serviço além da API da Anthropic (e Slack/WhatsApp quando eu ativar).
- Fixtures de teste sempre sintéticas — nunca transcrição real nos testes.

## 12. Custos

- Antes de processar em lote, mostre a estimativa ("X calls, ~Y tokens, ~US$ Z / ~R$ W") e peça confirmação.
- Batch API para histórico; prompt caching no bloco fixo.
- Custo por call visível no painel e no terminal.

## 13. Calibração (não pule)

- **`pnpm calibrate`**: eu avalio manualmente 10–15 calls num CSV (status por etapa + churn sim/não). O script compara com a IA: concordância por etapa, onde diverge e exemplos. Serve para ajustar critérios do playbook e o prompt.
- **Estabilidade:** reanalisar 5 calls duas vezes; se a nota variar mais de 10 pontos, apertar os critérios.
- **Retroativo:** com desfecho preenchido, rodar `/insights` e verificar se a nota tem relação com conversão. Se não tiver, sinalizar — pode ser o playbook, não o closer.

## 14. Preparar (sem construir) a integração com o CRM

- Interface `CallSource`: `LocalFolderSource` agora; `CrmSource` depois (API ou webhook de call finalizada).
- Interface `CrmWriter`: devolver resumo + próximos passos para a negociação no CRM.
- Futuro servidor MCP (uso "headless" pelo Claude) com ferramentas de leitura — `listar_calls`, `detalhar_call`, `resumo_closer`, `resumo_time`, `calls_criticas` — respeitando papel e escopo.
- Não implemente nada disso agora; só garanta que a arquitetura não bloqueia.

## 15. Fases e critérios de aceite

**Fase 0 — Reconhecimento (sem código de produto)**
Leia este documento, inspecione `data/inbox/` e me reporte: formatos, falantes, timestamps, qualidade, quantas calls, dúvidas em aberto. Proponha o plano. **Espere meu ok.**

**Fase 1 — Ingestão + métricas**
Parsers, normalização, papel dos falantes, triagem, métricas determinísticas, banco, `pnpm ingest`.
✅ Aceite: todas as amostras processadas; tabela no terminal com métricas por call; testes dos parsers passando.

**Fase 2 — Análise IA**
Prompt v1, schema Zod, verificação de evidências, classificação, custo. `pnpm analyze --call <id> | --all [--playbook <id>]`.
✅ Aceite: 3 calls analisadas nos dois playbooks; eu reviso o JSON; nenhuma citação inventada passa na verificação; custo por call registrado.

**Fase 3 — Painel**
Telas da seção 9.
✅ Aceite: consigo ir de uma call crítica até a citação na transcrição/vídeo em 2 cliques.

**Fase 4 — Relatórios, alertas, calibração, insights**
`report:daily`, alertas, dry-run, `calibrate`, `/insights`, `/custos`.
✅ Aceite: mensagem diária gerada em dry-run para cada gestor; relatório de calibração gerado.

**Fase 5 (futura)** — CRM + MCP.

## 16. Como trabalhar comigo

- Use plan mode no início de cada fase e me mostre o plano antes de implementar.
- Commits pequenos por fase. README com setup, comandos, variáveis de ambiente e como adicionar um playbook novo.
- Testes para parsers, métricas, verificação de evidências e regras de classificação.
- Ao fim de cada fase: resumo curto do que foi feito, o que eu devo testar e o que vem depois.

## 17. Pendências que vou te passar (pergunte se faltar)

- [ ] Amostras em `data/inbox/` (5 a 10 calls para começar, com desfecho)
- [ ] Playbook de closer da Make
- [ ] O que cada produto entrega e **não** entrega / promessas proibidas
- [ ] Time: closers, gestores, aliases, contatos
- [ ] Provedor de WhatsApp e webhook do Slack
- [ ] Barra mínima de nota e demais limiares (se eu não definir, proponha com base nos dados)
