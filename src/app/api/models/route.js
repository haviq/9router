import { NextResponse } from "next/server";
import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderNodes } from "@/models";

export const dynamic = "force-dynamic";

// GET /api/models - Menyajikan daftar model aktif nyata yang bisa di-route (sinkron dengan /v1/models)
export async function GET() {
  try {
    const [keys, nodes] = await Promise.all([
      getApiKeys().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);

    const activeKey = keys.find((k) => k.isActive)?.key || keys[0]?.key || "";
    const port = process.env.PORT || 20128;
    const headers = { "Content-Type": "application/json" };
    if (activeKey) headers["Authorization"] = `Bearer ${activeKey}`;

    // Panggil internal /v1/models untuk mendapatkan 600+ model yang beneran aktif & bisa di-route
    const v1Res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });

    if (!v1Res.ok) {
      throw new Error(`Internal /v1/models returned HTTP ${v1Res.status}`);
    }

    const v1Data = await v1Res.json();
    const rawModels = Array.isArray(v1Data?.data) ? v1Data.data : [];

    // Mapping UUID provider node ke prefix bersih jika ada
    const nodePrefixMap = {};
    nodes.forEach((n) => {
      if (!n) return;
      const prefix = (n.prefix || n.name || "").toLowerCase().replace(/\/.*$/, "");
      if (n.id && prefix) nodePrefixMap[n.id.toLowerCase()] = prefix;
    });

    // Format model agar kompatibel dengan seluruh komponen dashboard 9router
    const formattedModels = rawModels.map((m) => {
      let id = m.id || "";
      let provider = "direct";

      if (id.includes("/")) {
        const parts = id.split("/");
        const rawProv = parts[0];
        const mapped = nodePrefixMap[rawProv.toLowerCase()];
        if (mapped) {
          provider = mapped;
          id = `${mapped}/${parts.slice(1).join("/")}`;
        } else {
          provider = rawProv;
        }
      }

      return {
        id,
        model: m.id,
        name: m.name || m.id,
        provider,
        fullModel: id,
        routedModel: id,
        kind: m.kind || "llm",
      };
    });

    return NextResponse.json(formattedModels);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
