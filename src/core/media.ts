import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Duração da mídia em segundos via ffprobe; undefined se ffprobe faltar ou falhar. */
export async function probeDuration(file: string): Promise<number | undefined> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file,
    ]);
    const d = Number(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Disponibiliza o vídeo em data/media/ para o player (hardlink; cópia se não der). */
export function publishMedia(src: string, mediaDir: string, callId: string): string {
  fs.mkdirSync(mediaDir, { recursive: true });
  const dest = path.join(mediaDir, `${callId}${path.extname(src).toLowerCase()}`);
  if (!fs.existsSync(dest)) {
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
  }
  return dest;
}

// ---- Vídeo hospedado (Vercel Blob, R2…) ----

/**
 * Nome público do vídeo comprimido: id da call + código derivado de MEDIA_KEY_SALT (segredo do .env).
 * Ninguém adivinha o endereço de um vídeo sem passar pelo painel (que tem senha).
 */
export function mediaKey(callId: string, salt = process.env.MEDIA_KEY_SALT): string {
  if (!salt) throw new Error("MEDIA_KEY_SALT não definido no .env");
  const h = createHash("sha256").update(`${salt}:${callId}`).digest("hex").slice(0, 24);
  return `${callId}-${h}.mp4`;
}

export const blobPath = (callId: string) => `videos/${mediaKey(callId)}`;
/** Validade do link do vídeo hospedado. */
const LINK_HORAS = 4;

/**
 * URL do vídeo para o player.
 * - Vídeo por link (CRM): o próprio link.
 * - MEDIA_STORAGE=blob (deploy): vídeo PRIVADO no Vercel Blob; a cada visita o servidor gera um link
 *   assinado que expira em 4 h. Quem não passou pela senha do painel nunca recebe o link.
 * - Senão: a rota local /api/media/[id] (arquivo no seu PC, com suporte a Range).
 * Se o link não puder ser gerado, devolve undefined e a página abre sem vídeo.
 */
export async function mediaUrl(callId: string, mediaPath?: string | null): Promise<string | undefined> {
  // Vídeo que já mora num link (armazenamento do CRM): o player usa o link direto.
  if (mediaPath && /^https?:\/\//i.test(mediaPath)) return mediaPath;
  // Vídeos comprimidos dentro do próprio deploy (public/videos): protegidos pelo login do painel.
  if (process.env.MEDIA_STORAGE === "static") return `/videos/${mediaKey(callId)}`;
  if (process.env.MEDIA_STORAGE !== "blob") return `/api/media/${callId}`;
  try {
    const { issueSignedToken, presignUrl } = await import("@vercel/blob");
    const pathname = blobPath(callId);
    const validUntil = Date.now() + LINK_HORAS * 3600_000;
    const token = await issueSignedToken({ pathname, operations: ["get"], validUntil });
    const { presignedUrl } = await presignUrl(token, { operation: "get", pathname, access: "private", validUntil });
    return presignedUrl;
  } catch (e) {
    console.error(`Vídeo de ${callId}: link não gerado —`, (e as Error).message);
    return undefined;
  }
}

/**
 * Comprime para a web: 720p, 10 fps (é reunião com tela compartilhada), H.264 + AAC mono 48k,
 * `faststart` para tocar e pular sem baixar tudo. ~0,65 MB por minuto.
 */
export async function transcodeForWeb(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run("ffmpeg", [
    "-v", "error", "-y", "-i", src,
    "-vf", "scale=-2:720,fps=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-tune", "stillimage",
    "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-movflags", "+faststart", dest,
  ], { maxBuffer: 1024 * 1024 * 16 });
}
