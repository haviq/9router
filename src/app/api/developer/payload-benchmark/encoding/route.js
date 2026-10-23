import { buildLadder, ENCODING, MAX_FRAGMENTS } from "open-sse/payload/encodingLadder.js";

export const dynamic = "force-dynamic";

const MAX_TASK_CHARS = 2_000;

// GET /api/developer/payload-benchmark/encoding
//
// The encodings this ladder can produce, so the client does not hardcode a copy
// that drifts from the engine.
export async function GET() {
  return Response.json({
    encodings: [
      {
        id: ENCODING.FRAGMENT,
        note: "Split across turns — no single message holds the instruction.",
      },
      { id: ENCODING.CAESAR, note: "Shifted letters read as ordinary words to a raw-text filter." },
      { id: ENCODING.VIGENERE, note: "Per-position shift defeats a single-offset decoder." },
      { id: ENCODING.ACROSTIC, note: "First letter of each line; reads as prose to a line filter." },
    ],
    limits: { maxTaskChars: MAX_TASK_CHARS, maxFragments: MAX_FRAGMENTS },
  });
}

// POST /api/developer/payload-benchmark/encoding
//
// Body: { task, fragmentCount?, shift?, key? }
//
// Encodes one task four ways and reports the round-trip for each. No model call
// happens here: this is the preparation step, and the caller decides which
// encoding is worth sending. Reporting the round-trip matters because an
// encoding the caller cannot verify is a broken ladder, not a stealthy one.
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const task = typeof body?.task === "string" ? body.task.trim().slice(0, MAX_TASK_CHARS) : "";
  if (!task) return Response.json({ error: "task is required" }, { status: 400 });

  try {
    const ladder = buildLadder({
      task,
      fragmentCount: Number(body?.fragmentCount) || 3,
      shift: Number(body?.shift) || 3,
      key: typeof body?.key === "string" && body.key.trim() ? body.key.trim() : "key",
    });

    // Every entry must be reversible. If one is not, the ladder is broken and
    // the caller should know before spending a model call on it.
    const verified = ladder.every((entry) =>
      entry.id === ENCODING.FRAGMENT ? entry.lossless : entry.roundTrip,
    );

    return Response.json({ task, ladder, verified });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
