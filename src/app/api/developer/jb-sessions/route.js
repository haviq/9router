import { NextResponse } from "next/server";
import {
  saveJbSession,
  getJbSessions,
  getJbSessionById,
  deleteJbSession,
} from "@/lib/db/repos/jbSessionsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/developer/jb-sessions?model=...&verdict=...&presetId=...&id=...&limit=...
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      const session = await getJbSessionById(id);
      if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(session);
    }

    const sessions = await getJbSessions({
      model: url.searchParams.get("model") || undefined,
      verdict: url.searchParams.get("verdict") || undefined,
      presetId: url.searchParams.get("presetId") || undefined,
      limit: Number(url.searchParams.get("limit")) || 200,
    });
    return NextResponse.json(sessions);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/developer/jb-sessions
// Body: { model, messages, verdict, score?, presetId?, payloadId?, identity?, response?, reasoning?, temperature?, maxTokens?, notes? }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const saved = await saveJbSession(body);
    if (!saved) {
      return NextResponse.json({ error: "model and non-empty messages are required" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/developer/jb-sessions?id=...
export async function DELETE(request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await deleteJbSession(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
