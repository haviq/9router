import { resolvePayloadText } from "open-sse/payload/payloadRunner.js";
import { buildPayloadCatalog } from "open-sse/payload/payloadCatalog.js";

export const dynamic = "force-dynamic";

const MAX_TEXT_CHARS = 20_000;

// GET /api/developer/payload-benchmark/compare?a=<id>&b=<id>
//
// Resolve two payload ids to their text so they can be read side by side. The
// registry ships ~80 payloads from three collections, and there was no way to
// see how T100 differs from T105 without opening files on disk — which made
// "which of these two should I run" a guess.
//
// Text is capped: a couple of the collection entries are long, and shipping
// 200KB into a diff view helps nobody.
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const a = (url.searchParams.get("a") || "").trim();
    const b = (url.searchParams.get("b") || "").trim();

    if (!a || !b) {
      return Response.json({ error: "both a and b are required" }, { status: 400 });
    }

    const catalog = buildPayloadCatalog();
    const meta = new Map(catalog.map((row) => [row.id, row]));

    const resolve = (id) => {
      const text = resolvePayloadText(id);
      if (text === null) return { id, found: false };
      const row = meta.get(id) || {};
      return {
        id,
        found: true,
        cat: row.cat || null,
        source: row.source || null,
        estTokens: row.estTokens || null,
        chars: text.length,
        lines: text.split("\n").length,
        text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
        truncated: text.length > MAX_TEXT_CHARS,
      };
    };

    const left = resolve(a);
    const right = resolve(b);

    return Response.json({
      a: left,
      b: right,
      maxTextChars: MAX_TEXT_CHARS,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
