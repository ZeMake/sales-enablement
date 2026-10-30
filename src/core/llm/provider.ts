import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { getClient } from "./client";
import { costUsd, type Usage } from "./pricing";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmRequest<T> = {
  model: string;
  /** Bloco fixo (instruções + playbook + regras): fica em cache entre calls. */
  system: string;
  /** Parte variável (a transcrição da call). */
  user: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  /** Só modelos que aceitam amostragem (ex.: Haiku 4.5); ignorado nos demais. */
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

export type LlmResult<T> = {
  data: T;
  model: string;
  usage: Usage;
  /** Na API é custo real; na assinatura é o custo equivalente se fosse pela API. */
  costUsd: number;
  billing: "api" | "assinatura";
};

export interface LlmProvider {
  readonly name: "api" | "claude-cli" | "openrouter";
  complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export class LlmOutputError extends Error {}

function validate<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const res = schema.safeParse(data);
  if (!res.success) throw new LlmOutputError(`${where}: saída fora do schema — ${z.prettifyError(res.error)}`);
  return res.data;
}

// Modelos que rejeitam temperature (a partir da família 4.7 / 5).
const acceptsSampling = (model: string) => /haiku-4-5|sonnet-4-[56]|opus-4-[56]/.test(model);
const acceptsEffort = (model: string) => !/haiku/.test(model);

/** Claude API (créditos pagos). */
export class ApiProvider implements LlmProvider {
  readonly name = "api" as const;

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const response = await getClient().messages.parse(
      {
        model: req.model,
        max_tokens: req.maxTokens ?? 32000,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: zodOutputFormat(req.schema),
          ...(req.effort && acceptsEffort(req.model) ? { effort: req.effort } : {}),
        },
        ...(req.temperature !== undefined && acceptsSampling(req.model) ? { temperature: req.temperature } : {}),
      },
      { timeout: req.timeoutMs ?? 15 * 60_000 },
    );
    if (response.stop_reason === "refusal") throw new LlmOutputError(`Modelo recusou: ${response.stop_details?.explanation ?? ""}`);
    if (response.stop_reason === "max_tokens") throw new LlmOutputError("Resposta cortada por max_tokens");
    const data = validate(req.schema, response.parsed_output, "API");
    return { data, model: req.model, usage: response.usage, costUsd: costUsd(req.model, response.usage), billing: "api" };
  }
}

/** "claude-opus-5-5" → "anthropic/claude-opus-5.5" (id da OpenRouter); ids com "/" passam direto. */
export const openRouterModel = (model: string) => (model.includes("/") ? model : `anthropic/${model.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`);

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; cost?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string; code?: number; metadata?: { raw?: string; provider_name?: string } };
};

/**
 * Claude pela OpenRouter (créditos da OpenRouter): mesmo modelo, mesmas instruções e o mesmo schema
 * da API da Anthropic; custo real vem em usage.cost. Usado na versão publicada (Vercel), onde não há
 * Claude Code. Pede para a OpenRouter não guardar os dados.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter" as const;
  constructor(private fetcher: typeof fetch = fetch) {}

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY não definido");
    // A resposta vem pela ferramenta `registrar_resultado` (não estrita): o modelo preenche os campos
    // obrigatórios da ferramenta com muito mais fidelidade do que um schema descrito no texto, e o modo
    // estrito não serve (o schema da análise é grande demais para a "gramática" da Anthropic).
    // A garantia final é a validação Zod abaixo, com uma segunda tentativa mostrando o erro exato.
    const schema = cliJsonSchema(req.schema);
    const system = `${req.system}\n\n# Como responder (obrigatório)\nEntregue o resultado chamando a ferramenta \`registrar_resultado\` UMA vez, com TODOS os campos obrigatórios preenchidos em todos os itens das listas (inclusive em cada objeção: tratamento e resolvida). Não escreva o resultado como texto.`;
    const mensagens: Array<{ role: "user" | "assistant"; content: string }> = [{ role: "user", content: req.user }];
    let usoTotal: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let custo = 0;
    const inicio = Date.now();
    const limite = req.timeoutMs ?? 280_000; // cabe nos 300 s da função na Vercel
    for (let tentativa = 1; ; tentativa++) {
      const { texto, usage, cost } = await this.chamar(key, req, system, mensagens, schema, Math.max(10_000, limite - (Date.now() - inicio)));
      usoTotal = {
        input_tokens: usoTotal.input_tokens + usage.input_tokens,
        output_tokens: usoTotal.output_tokens + usage.output_tokens,
        cache_read_input_tokens: (usoTotal.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      };
      custo += cost ?? costUsd(req.model, usage);
      try {
        const data = validate(req.schema, extrairJson(texto), "OpenRouter");
        return { data, model: req.model, usage: usoTotal, costUsd: custo, billing: "api" };
      } catch (e) {
        if (tentativa >= 2) {
          // O custo das tentativas que falharam também é real: vai junto no erro para ser registrado.
          throw Object.assign(e as Error, { custoUsd: custo, usage: usoTotal });
        }
        mensagens.push({ role: "user", content: `Atenção: a tentativa anterior veio incompleta: ${(e as Error).message.slice(0, 1500)}\nChame registrar_resultado de novo com TODOS os campos obrigatórios.` });
      }
    }
  }

  private async chamar(key: string, req: LlmRequest<unknown>, system: string, mensagens: Array<{ role: string; content: string }>, schema: Record<string, unknown>, timeoutMs: number) {
    const body = {
      model: openRouterModel(req.model),
      max_tokens: req.maxTokens ?? 32000,
      messages: [{ role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }, ...mensagens],
      tools: [{ type: "function", function: { name: "registrar_resultado", description: "Registra o resultado completo no formato exigido.", parameters: schema } }],
      // Com raciocínio ligado a Anthropic não aceita forçar a ferramenta: "auto" + instrução explícita.
      tool_choice: "auto",
      ...(req.effort && acceptsEffort(req.model) ? { reasoning: { effort: req.effort === "low" || req.effort === "medium" ? req.effort : "high" } } : {}),
      ...(req.temperature !== undefined && acceptsSampling(req.model) ? { temperature: req.temperature } : {}),
      usage: { include: true },
      provider: { data_collection: "deny" },
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Sales Enablement Make" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json()) as OpenRouterResponse;
      if (!res.ok || json.error) {
        if (res.status === 402) throw new Error("OpenRouter: sem créditos (402)");
        const detalhe = json.error?.metadata?.raw ? ` — ${json.error.metadata.raw.slice(0, 400)}` : "";
        throw new Error(`OpenRouter ${res.status}: ${json.error?.message ?? "erro"}${detalhe}`);
      }
      const choice = json.choices?.[0];
      if (choice?.finish_reason === "length") throw new LlmOutputError("Resposta cortada por max_tokens");
      const u = json.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      const usage: Usage = { input_tokens: u.prompt_tokens - cached, output_tokens: u.completion_tokens, cache_read_input_tokens: cached };
      const chamada = choice?.message?.tool_calls?.find((t) => t.function?.name === "registrar_resultado");
      return { texto: chamada?.function?.arguments ?? choice?.message?.content ?? "", usage, cost: u.cost };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Tira o JSON da resposta (tolera cerca de markdown ou texto em volta). */
export function extrairJson(texto: string): unknown {
  const limpo = texto.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(limpo);
  } catch {
    const i = limpo.indexOf("{");
    const j = limpo.lastIndexOf("}");
    if (i >= 0 && j > i) return JSON.parse(limpo.slice(i, j + 1));
    throw new LlmOutputError("OpenRouter: resposta não é JSON");
  }
}

type CliJson = {
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  modelUsage?: Record<
    string,
    { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }
  >;
};

function cliVersion(bin: string): number[] | undefined {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return out.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  } catch {
    return undefined;
  }
}

const cmpVersion = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * Binário do Claude Code: CLAUDE_CLI_PATH, ou a versão mais nova entre o PATH,
 * ~/.local/bin e a extensão do VS Code (modelos novos exigem CLI recente).
 */
export function resolveClaudeCli(): { bin: string; version: string } {
  const candidates = new Set<string>();
  if (process.env.CLAUDE_CLI_PATH) candidates.add(process.env.CLAUDE_CLI_PATH);
  else {
    try {
      candidates.add(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
    } catch {
      /* fora do PATH */
    }
    candidates.add(path.join(os.homedir(), ".local/bin/claude"));
    const ext = path.join(os.homedir(), ".vscode/extensions");
    if (fs.existsSync(ext))
      for (const d of fs.readdirSync(ext).filter((d) => d.startsWith("anthropic.claude-code-")))
        candidates.add(path.join(ext, d, "resources/native-binary/claude"));
  }
  const found = [...candidates]
    .filter((c) => c && fs.existsSync(c))
    .map((bin) => ({ bin, v: cliVersion(bin) }))
    .filter((c): c is { bin: string; v: number[] } => !!c.v)
    .sort((a, b) => cmpVersion(b.v, a.v));
  if (!found.length) throw new Error("Claude Code CLI não encontrado. Instale o Claude Code ou defina CLAUDE_CLI_PATH.");
  return { bin: found[0].bin, version: found[0].v.join(".") };
}

/**
 * Claude Code em modo headless (`claude -p`): consome a assinatura do Claude, sem créditos de API.
 * Roda com contexto mínimo — prompt de sistema próprio, sem ferramentas, MCP, settings ou skills.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly name = "claude-cli" as const;
  private bin?: string;

  private binary() {
    return (this.bin ??= resolveClaudeCli().bin);
  }

  async complete<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const args = [
      "-p",
      "--model", req.model,
      "--system-prompt", req.system,
      "--output-format", "json",
      "--json-schema", JSON.stringify(cliJsonSchema(req.schema)),
      "--no-session-persistence",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--disable-slash-commands",
      ...(req.effort && acceptsEffort(req.model) ? ["--effort", req.effort] : []),
    ];
    const stdout = await runCli(this.binary(), args, req.user, req.timeoutMs ?? 20 * 60_000);
    let out: CliJson;
    try {
      out = JSON.parse(stdout) as CliJson;
    } catch {
      throw new LlmOutputError(`claude -p devolveu algo que não é JSON: ${stdout.slice(0, 300)}`);
    }
    if (out.is_error) throw new LlmOutputError(`claude -p: ${out.result?.slice(0, 500)}`);
    const data = validate(req.schema, out.structured_output, "claude -p");

    // A CLI também usa um modelo leve internamente; soma só o uso do modelo pedido.
    const mu = Object.entries(out.modelUsage ?? {}).filter(([m]) => m.startsWith(req.model));
    const usage: Usage = {
      input_tokens: mu.reduce((a, [, u]) => a + u.inputTokens, 0),
      output_tokens: mu.reduce((a, [, u]) => a + u.outputTokens, 0),
      cache_read_input_tokens: mu.reduce((a, [, u]) => a + u.cacheReadInputTokens, 0),
      cache_creation_input_tokens: mu.reduce((a, [, u]) => a + u.cacheCreationInputTokens, 0),
    };
    return { data, model: req.model, usage, costUsd: out.total_cost_usd ?? 0, billing: "assinatura" };
  }
}

/** A CLI valida o schema com draft-07 e não reconhece o `$schema` 2020-12 que o Zod gera por padrão. */
export function cliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function runCli(bin: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // cwd neutro: nada de CLAUDE.md ou config do projeto entrando no contexto.
    const child = spawn(bin, args, { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`claude -p excedeu ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || out.trim().startsWith("{")) resolve(out);
      else reject(new Error(`claude -p saiu com código ${code}: ${(err || out).slice(0, 500)}`));
    });
    child.stdin.end(stdin);
  });
}

let provider: LlmProvider | undefined;

export function getProvider(): LlmProvider {
  if (provider) return provider;
  const name = process.env.LLM_PROVIDER ?? "claude-cli";
  if (name === "api") return (provider = new ApiProvider());
  if (name === "claude-cli") return (provider = new ClaudeCliProvider());
  if (name === "openrouter") return (provider = new OpenRouterProvider());
  throw new Error(`LLM_PROVIDER inválido: ${name} (use claude-cli, api ou openrouter)`);
}

/** Para testes. */
export function setProvider(p: LlmProvider | undefined) {
  provider = p;
}

export function llmAvailable(): boolean {
  const name = process.env.LLM_PROVIDER ?? "claude-cli";
  if (name === "api") return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (name === "openrouter") return Boolean(process.env.OPENROUTER_API_KEY);
  try {
    resolveClaudeCli();
    return true;
  } catch {
    return false;
  }
}
