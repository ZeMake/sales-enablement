# Publicar na Vercel (versão de validação)

Versão para o time validar: **login por e-mail e senha**, **só leitura**, tudo hospedado **só na Vercel**.
Rode tudo nesta pasta: `cd ~/Documents/TRAMPOS/MAKE-Sales-Enablement`.

## O que vai para onde

| Peça | Onde fica | Observação |
|---|---|---|
| Código do painel | Vercel | `data/`, `out/` e `.env` nunca sobem (`.vercelignore`). |
| Banco | Dentro do deploy (`snapshot/app.db`) | Cópia do momento da publicação, aberta só leitura. |
| Vídeos das calls da pasta local | Dentro do deploy (`public/videos/`) | Comprimidos (~30 MB cada) e **atrás do login**: sem entrar, nenhum vídeo abre. |
| Vídeos das calls por link do CRM | No próprio armazenamento do CRM | O player toca do link; nada é copiado. |

São dados reais de leads (LGPD): o acesso só deve circular dentro do time.

## 1. Montar o pacote (no PC, sem enviar nada)

```bash
pnpm media:web          # comprime vídeos novos da pasta local (os já feitos são pulados)
pnpm deploy:prepare     # cópia do banco + vídeos (hardlink, sem espaço extra)
```

## 2. Login e projeto na Vercel (uma vez)

```bash
npx vercel login        # escolha o método e confirme no navegador
npx vercel link         # crie o projeto "sales-enablement"
```

## 3. Variáveis (uma vez)

Para cada linha: `npx vercel env add NOME production` e cole o valor.

| Variável | Valor |
|---|---|
| `SITE_LOGIN` | e-mail de acesso do time |
| `SITE_PASSWORD` | senha de acesso do time |
| `READ_ONLY` | `true` |
| `DB_SNAPSHOT` | `snapshot/app.db` |
| `MEDIA_STORAGE` | `static` |
| `MEDIA_KEY_SALT` | o **mesmo** valor do seu `.env` (é o que dá nome aos vídeos) |
| `VIEWER_ID` | `victor` |
| `NOTIFY_DRY_RUN` | `true` |
| `USD_BRL` | `5.40` |

## 4. Publicar

```bash
npx vercel --prod
```

Abra o link: deve pedir e-mail e senha. Depois de entrar, o cabeçalho mostra **"Validação · só leitura"**.

## Atualizar depois

Calls novas, análises refeitas ou código novo: repita o **passo 1** e o **passo 4**.
Para trocar o acesso, mude `SITE_LOGIN`/`SITE_PASSWORD` na Vercel e publique de novo: os acessos antigos caem.

## Calls por link do CRM

```bash
pnpm ingest:url "<link da transcrição .txt>"     # acha o vídeo ao lado (.webm) sozinho
pnpm analyze --call crm-xxxxxxxx
```

## Adicionar call na versão publicada

Desde 01/10/2026 o time pode **adicionar calls e ver o resultado** no link publicado (o resto continua só leitura).

| Peça | Como funciona |
|---|---|
| Banco | **Turso** (integração da Vercel, plano Starter gratuito), gravável. `pnpm db:push --force` copia o banco local para lá. |
| Análise | **OpenRouter** (`LLM_PROVIDER=openrouter`, `OPENROUTER_API_KEY`), mesmo modelo Claude Opus 5.5. ~4 min e ~US$ 0,75 por playbook (**~US$ 1,50 por call**), nos créditos da OpenRouter. |
| Fila | Um passo por chamada de `/api/fila` (triagem → cada playbook → segunda opinião), cada um < 300 s; o passo dispara o seguinte. Trava por call evita análise em dobro. |
| Limite | `MAX_CALLS_DIA=10` (teto de ~US$ 15/dia). |

Variáveis extras em produção: `LLM_PROVIDER`, `OPENROUTER_API_KEY`, `ANALYSIS_MODEL`, `LIGHT_MODEL`, `JEV_MODEL`, `JOBS_MODE=vercel`,
`JOB_SECRET`, `APP_URL`, `ALLOW_ADD_CALL=true`, `MAX_CALLS_DIA`, `PROCESSED_DIR=/tmp/processed`, `NOTIFY_OUT_DIR=/tmp/notifications`,
e `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` (criadas pela integração).

**Limite conhecido:** o plano Hobby corta cada passo em 300 s. Calls muito longas (> ~60 min) podem estourar o tempo
da análise e aparecer como "erro" na fila.

**Atenção:** o banco publicado (Turso) e o local (`data/app.db`) são separados. Calls analisadas no PC só aparecem no link depois de `pnpm db:push --force` (que **substitui** o que foi adicionado pelo time).
