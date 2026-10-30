/**
 * Jev (TypeSafe) pela OpenRouter — API de decisões: um `state` e perguntas tipadas
 * (noul = sim/não, choice = uma opção, score = escala) com probabilidades na resposta.
 * Cobra só tokens de entrada; cada resposta traz `usage.cost` em US$.
 * Doc: https://openrouter.ai/docs/guides/community/jev
 */

export type NoulQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };
export type ScoreAnswer = { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type DecisionResponse = {
  id: string;
  model: string;
  provider: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number; cost: number };
};

/** US$ por token de entrada do Jev 1.13 (saída é grátis). Só para estimativa; o custo real vem em usage.cost. */
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
/** Contexto: 32k tokens para state + a pergunta mais longa. */
export const JEV_STATE_BUDGET_TOKENS = 28_000;

export const jevModel = () => process.env.JEV_MODEL ?? "typesafe/jev-1.13";
export const jevAvailable = () => !!process.env.OPENROUTER_API_KEY;
/** Padrão: mascarar dados pessoais antes de mandar para a OpenRouter/TypeSafe (JEV_MASK_PII=false desliga). */
export const jevMaskPii = () => process.env.JEV_MASK_PII !== "false";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export async function decide(
  req: { state: string | object; questions: Record<string, Question> },
  opts: { fetch?: FetchLike; retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<DecisionResponse> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY não definido no .env");
  const f = opts.fetch ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = process.env.JEV_URL ?? "https://openrouter.ai/api/alpha/decisions";
  const body = JSON.stringify({
    model: jevModel(),
    state: req.state,
    questions: req.questions,
    // Pede para a OpenRouter não usar/guardar os dados (retenção zero só existe no plano enterprise da TypeSafe).
    provider: { data_collection: "deny" },
  });
  const retries = opts.retries ?? 4;
  for (let i = 0; ; i++) {
    const res = await f(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Sales Enablement Make" }, body });
    if (res.ok) return (await res.json()) as DecisionResponse;
    const retryable = [429, 500, 502, 503, 524, 529].includes(res.status);
    if (!retryable || i >= retries) {
      const msg = await res.text().catch(() => "");
      if (res.status === 402) throw new Error("Jev: sem créditos na OpenRouter (402)");
      if (res.status === 401) throw new Error("Jev: chave da OpenRouter inválida (401)");
      throw new Error(`Jev respondeu ${res.status}: ${msg.slice(0, 300)}`);
    }
    await sleep(Math.min(30_000, 1000 * 2 ** i));
  }
}

/** ≈3,5 caracteres por token em PT-BR. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);
