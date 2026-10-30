import type { ManifestRow } from "./manifest";

/** Uma call disponível numa origem (pasta local hoje, CRM depois). */
export type SourceCall = {
  call_id: string;
  /** sha256 do arquivo de transcrição (ou do vídeo, se não houver transcrição). Base da idempotência. */
  hash: string;
  transcriptPath?: string;
  videoPath?: string;
  meta: ManifestRow;
  /** Horário de cada fala, na ordem da transcrição, quando a origem o informa à parte (API do CRM). */
  tempos?: Array<{ start: number; end: number }>;
  /** De onde vieram os metadados. */
  metaOrigem: "manifest" | "nome_do_arquivo";
};

export interface CallSource {
  readonly name: string;
  list(): Promise<{ calls: SourceCall[]; warnings: string[] }>;
  readTranscript(call: SourceCall): Promise<string>;
}
