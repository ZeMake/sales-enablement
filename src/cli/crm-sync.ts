/**
 * pnpm crm:sync --from 2026-09-01 [--to 2026-10-07] [--call crm-xxxxxxxx] [--publicado] [--no-llm] [--force]
 * pnpm crm:sync --from 2026-09-01 --desfechos [--publicado]   só atualiza ganho/perdido das calls que já estão no painel
 * Puxa da API do MakeCRM as reuniões gravadas dos closers no período e ingere as que ainda não estão
 * no banco (transcrição e vídeo lidos pelos links do bucket, nada copiado). Leva do CRM: closer, data,
 * lead e desfecho da oportunidade, e o horário de cada fala (para sincronizar com o vídeo). O closer é
 * conferido pelos falantes da transcrição. Gravações curtas demais (no-show) ficam de fora.
 * --publicado grava direto no banco da versão publicada (Turso). Depois: pnpm analyze --all [--publicado].
 */
import { loadConfig, matchPerson } from "../core/config";
import { ingestCall, syncPeople } from "../core/ingest";
import { parseTxt } from "../core/parsers";
import { atualizarDesfechos, CrmApi, reunioesDosClosers } from "../core/sources/crm-api";
import { UrlSource } from "../core/sources/url";
import { abrirBanco, flag, loadEnv, mmss, option } from "./_shared";

/** Abaixo disso a gravação não tem conversa (no-show, sala vazia). */
const MIN_CARACTERES = 1500;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const from = option(args, "from");
  if (!from) throw new Error("Use --from AAAA-MM-DD (e, se quiser, --to AAAA-MM-DD)");
  const cfg = loadConfig();
  const db = await abrirBanco(args);
  await syncPeople(db, cfg);

  const api = new CrmApi();
  if (flag(args, "desfechos")) {
    const mudaram = await atualizarDesfechos(db, api, cfg.team, from);
    for (const m of mudaram) console.log(`${m.id} · ${m.lead}: ${m.de ?? "sem desfecho"} → ${m.para}`);
    return console.log(`\n${mudaram.length} desfecho(s) atualizado(s) pelo CRM.`);
  }
  const { itens, semGravacao } = await reunioesDosClosers(api, cfg.team, from, option(args, "to"));
  const doCrm = new Map(itens.map((it) => [it.meta!.call_id!, it]));
  console.log(`${itens.length + semGravacao} reunião(ões) dos closers; ${itens.length} com transcrição, ${semGravacao} sem gravação.\n`);

  const so = option(args, "call");
  const src = new UrlSource(so ? itens.filter((it) => it.meta!.call_id === so) : itens, cfg.team);
  const { calls } = await src.list();
  const n = { ingerida: 0, reprocessada: 0, meta_atualizada: 0, ignorada: 0, curta: 0, erro: 0 };
  for (const sc of calls) {
    const texto = await src.readTranscript(sc);
    if (texto.length < MIN_CARACTERES) {
      n.curta++;
      continue;
    }
    // O closer de verdade é quem fala na call: o do CRM (oportunidade/convite) às vezes é outro.
    const crm = doCrm.get(sc.call_id)!;
    const falantes = new Set(parseTxt(texto).map((s) => matchPerson(cfg.team, s.speaker)).filter((p) => p?.papeis.includes("closer")).map((p) => p!.id));
    const closer = falantes.size === 1 ? [...falantes][0] : (crm.closers.find((c) => falantes.has(c)) ?? crm.closers[0]);
    if (closer !== sc.meta.closer) console.log(`  ${sc.call_id}: closer pelo áudio = ${closer} (CRM dizia ${sc.meta.closer})`);
    sc.meta.closer = closer;
    sc.tempos = await api.tempos(crm.meetingId).catch(() => undefined);
    try {
      const r = await ingestCall(db, cfg, src, sc, { llm: flag(args, "no-llm") ? false : undefined, force: flag(args, "force") });
      n[r.acao]++;
      console.log(
        `${sc.call_id} · ${sc.meta.data_hora?.slice(0, 10)} · ${sc.meta.closer} · ${sc.meta.lead_nome}: ${r.acao}` +
          (r.motivo ? ` (${r.motivo})` : "") +
          (r.metrics ? ` · ${mmss(r.metrics.duracao_total_seg)} · ${r.triage?.status}` : ""),
      );
    } catch (e) {
      n.erro++;
      console.log(`${sc.call_id} · ${sc.meta.lead_nome}: ERRO ${(e as Error).message}`);
    }
  }
  console.log(
    `\nIngeridas ${n.ingerida} · reprocessadas ${n.reprocessada} · já estavam ${n.ignorada + n.meta_atualizada} · ` +
      `curtas demais ${n.curta} · erros ${n.erro}`,
  );
  console.log(`Próximo passo: pnpm analyze --all${flag(args, "publicado") ? " --publicado" : ""}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
