import { NextResponse } from "next/server";
import { getModelAliases, getCustomModels, getProviderConnections, getProviderNodes } from "@/models";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias, ALIAS_TO_ID } from "@/shared/constants/providers";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";

// GET /api/models - Get models for dashboard with aliases and clean active providers
export async function GET() {
  try {
    const modelAliases = await getModelAliases().catch(() => ({}));
    const disabled = await getDisabledModels().catch(() => ({}));
    const [connections, nodes] = await Promise.all([
      getProviderConnections().catch(() => []),
      getProviderNodes().catch(() => []),
    ]);

    // Kumpulkan provider aktif dari connections
    const activeProviders = new Set();
    connections.forEach((c) => {
      if (c && c.isActive !== false) {
        if (c.provider) activeProviders.add(c.provider.toLowerCase());
        const alias = getProviderAlias(c.provider);
        if (alias) activeProviders.add(alias.toLowerCase());
      }
    });

    // Mapping UUID node -> clean prefix (kl, ifx, mg, cn, ar, at, etc.)
    const nodePrefixMap = {};
    nodes.forEach((n) => {
      if (!n) return;
      const isDisabled = n.disabled || n.isDisabled || n.isActive === false;
      if (!isDisabled) {
        const cleanPrefix = (n.prefix || n.name || "custom").toLowerCase().replace(/\/.*$/, "");
        if (n.id) nodePrefixMap[n.id.toLowerCase()] = cleanPrefix;
        activeProviders.add(cleanPrefix);
        if (n.id) activeProviders.add(n.id.toLowerCase());
      }
    });

    // Filter AI_MODELS: HANYA yang provider-nya benar-benar aktif punya koneksi di instance user!
    // Model dummy bawaan (SAMBA, LOCAL-DEVICE, SELFHOSTED-*, MMF, dll) yang tidak terhubung otomatis DIBUANG!
    const models = AI_MODELS
      .filter((m) => {
        const alias = (getProviderAlias(m.provider) || m.provider || "").toLowerCase();
        const rawProv = (m.provider || "").toLowerCase();
        if (!activeProviders.has(alias) && !activeProviders.has(rawProv)) {
          return false;
        }
        const list = disabled[alias] || disabled[m.provider] || [];
        return !list.includes(m.model);
      })
      .map((m) => {
        const fullModel = `${m.provider}/${m.model}`;
        const providerAlias = getProviderAlias(m.provider) || m.provider;
        const routedModel = `${providerAlias}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        return {
          ...m,
          fullModel,
          routedModel,
          alias: modelAliases[fullModel] || m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            contextWindow: c.contextWindow,
            maxOutput: c.maxOutput,
          },
        };
      });

    // Masukkan custom models dari providerNodes & customModels
    const seenFull = new Set(models.map((m) => m.fullModel));
    const seenRouted = new Set(models.map((m) => m.routedModel));
    const rawCustomModels = (await getCustomModels().catch(() => [])).filter((m) => {
      return m?.id && (m.kind || m.type || "llm") === "llm";
    });

    for (const m of rawCustomModels) {
      const rawAlias = (m.providerAlias || "").toLowerCase();
      // Petakan jika providerAlias berupa UUID openai-compatible-chat-...
      const cleanAlias = nodePrefixMap[rawAlias] || m.providerAlias;

      const fullModel = `${cleanAlias}/${m.id}`;
      if (seenRouted.has(fullModel) || seenFull.has(fullModel)) continue;
      seenFull.add(fullModel);
      seenRouted.add(fullModel);

      const providerId = ALIAS_TO_ID[cleanAlias] || cleanAlias;
      const c = getCapabilitiesForModel(providerId, m.id);
      models.push({
        provider: cleanAlias,
        model: m.id,
        name: m.name || m.id,
        fullModel,
        routedModel: fullModel,
        alias: modelAliases[fullModel] || m.id,
        caps: {
          vision: c.vision,
          search: c.search,
          reasoning: c.reasoning,
          contextWindow: c.contextWindow,
          maxOutput: c.maxOutput,
        },
      });
    }

    return NextResponse.json(models);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
