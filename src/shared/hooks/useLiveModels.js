"use client";

import { useEffect, useState } from "react";

// Live model list for pages that are not the Developer tab.
//
// The Developer page builds its model list from a provider registry it already
// loads, and passes it down as a prop. The standalone payload pages had no such
// parent, so they declared `modelOptions = []` and rendered a dropdown with
// nothing in it — every Run button disabled with no explanation.
//
// This hook fetches the same list from /api/models, which is the dashboard-side
// endpoint (auth via the dashboard session, so it works without an API key).
// /v1/models is tried first because it only lists models that can actually
// route, and falls back to /api/models when no key is configured.
export default function useLiveModels() {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // /v1/models returns {id, ...}. /api/models returns {provider, model,
      // fullModel, routedModel} with NO `id` field — filtering on `m.id` dropped
      // every row and the dropdown stayed empty even though the endpoint was
      // fine. Derive the id from whatever the payload actually carries.
      const normalise = (raw) =>
        raw
          .map((m) => {
            if (typeof m === "string") return { id: m, requestModel: m };
            if (!m) return null;
            const id = m.id || m.routedModel || m.fullModel || (m.provider && m.model ? `${m.provider}/${m.model}` : "");
            if (!id) return null;
            return { ...m, id, requestModel: m.requestModel || m.routedModel || m.fullModel || id };
          })
          .filter(Boolean);

      try {
        const live = await fetch("/v1/models", { cache: "no-store" });
        if (live.ok) {
          const body = await live.json().catch(() => ({}));
          const list = normalise(Array.isArray(body?.data) ? body.data : []);
          if (list.length) {
            if (!cancelled) {
              setModels(list);
              setError("");
            }
            return;
          }
        }
      } catch {
        // fall through to the dashboard endpoint
      }

      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        const list = normalise(Array.isArray(body?.models) ? body.models : []);
        if (!cancelled) {
          setModels(list);
          setError(list.length ? "" : "No models found — connect a provider first");
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Could not load models");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { models, loading, error };
}
