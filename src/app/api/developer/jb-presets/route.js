import { NextResponse } from "next/server";
import {
  saveJbPreset,
  getJbPresets,
  getJbPresetByName,
  deleteJbPreset,
} from "@/lib/db/repos/jbPresetsRepo.js";

export const dynamic = "force-dynamic";

// GET /api/developer/jb-presets?model=...&activeOnly=1
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const model = url.searchParams.get("model") || undefined;
    const activeOnly = url.searchParams.get("activeOnly") === "1";
    const name = url.searchParams.get("name");

    if (name) {
      const preset = await getJbPresetByName(name);
      if (!preset) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json(preset);
    }

    const presets = await getJbPresets({ model, activeOnly });
    return NextResponse.json(presets);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST /api/developer/jb-presets
// Body: { name, model, payloadId?, identity?, registerLevel?, temperature?, maxTokens?, topP?, notes?, verifiedAt?, breachRate?, probeCount? }
export async function POST(request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

    const saved = await saveJbPreset(body);
    if (!saved) return NextResponse.json({ error: "name and model are required" }, { status: 400 });

    return NextResponse.json({ ok: true, ...saved });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/developer/jb-presets?id=...
export async function DELETE(request) {
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    await deleteJbPreset(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
