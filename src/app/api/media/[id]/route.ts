import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { getCallDetail } from "@/core/queries";
import { getContext } from "@/lib/server/context";

const TYPES: Record<string, string> = { ".webm": "video/webm", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

/** Serve o vídeo da call com suporte a Range (necessário para pular para um momento). */
export async function GET(req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  const { db, viewer } = await getContext();
  const detail = await getCallDetail(db, viewer, id); // respeita escopo do viewer
  const file = detail?.call.media_path;
  if (file && /^https?:\/\//i.test(file)) return Response.redirect(file, 302); // vídeo no armazenamento do CRM
  if (!file || !fs.existsSync(file)) return new Response("Sem vídeo", { status: 404 });

  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (!range) {
    const body = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
    return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(size), "Accept-Ranges": "bytes" } });
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : Math.min(start + 8 * 1024 * 1024 - 1, size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Type": type,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
