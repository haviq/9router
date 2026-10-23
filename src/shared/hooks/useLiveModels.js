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
      const normalise = (raw) =>
        raw
          .map((m) => (typeof m === "string" ? { id: m } : m))
          .filter((m) => m && m.id)
          .map((m) => ({ ...m, requestModel: m.requestModel || m.routedModel || m.id }));

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
