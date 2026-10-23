"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";

// Cross-model transfer planner.
//
// One measurement is evidence about a family, not just about one model —
// mg/deepseek took three different frames while cn/minimax took one, and each
// provider's guard character is stable across its model list. So this page
// turns stored results into a ranked list of what to try next on the siblings,
// which is where a full sweep wastes most of its calls.
//
// Nothing here runs anything. The plan is a hypothesis list; a candidate only
// becomes a result after the Benchmark tab measures it. That distinction is
// the whole point — a transfer recorded without measurement is a guess wearing
// a result's clothes.

export default function TransferClient({ modelOptions = [] }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Only models that can actually route belong in the known universe. Offering
  // a transfer to a model this instance cannot reach is a plan that cannot run.
  const knownIds = useMemo(
    () => modelOptions.map((m) => m.requestModel || m.id).filter(Boolean),
    [modelOptions],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (knownIds.length) params.set("known", knownIds.join(","));
      params.set("limit", "60");
      const res = await fetch(`/api/developer/payload-benchmark/transfer?${params}`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setError(e?.message || "Failed to build transfer plan");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [knownIds]);

  // Initial load only. `loading` starts true, so no setState before the fetch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (knownIds.length) params.set("known", knownIds.join(","));
        params.set("limit", "60");
        const res = await fetch(`/api/developer/payload-benchmark/transfer?${params}`, {
          cache: "no-store",
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to build transfer plan");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [knownIds]);

  const plan = data?.plan || [];
  const byFamily = data?.byFamily || {};
  const families = Object.keys(byFamily).sort();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">Payload Transfer</h1>
          <p className="text-xs text-text-muted">
            Where a payload already worked on one model, try it on the siblings first.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-error/40">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-error">error</span>
            <div>
              <p className="text-sm font-semibold">Could not build the plan</p>
              <p className="text-xs text-text-muted">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {loading && !data && <CardSkeleton />}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Measured runs
              </span>
              <div className="text-lg font-bold xl:text-xl">{data.sourceRuns || 0}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Candidates
              </span>
              <div className="text-lg font-bold xl:text-xl">{data.planCount || 0}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Families
              </span>
              <div className="text-lg font-bold xl:text-xl">{families.length}</div>
            </Card>
          </div>

          <Card padding="none">
            {plan.length === 0 ? (
              <div className="p-6 text-center text-sm text-text-muted">
                No candidates. Either nothing has been measured yet — run a payload in the
                Benchmark tab first — or every sibling of a working model has already been tested.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-left text-xs sm:text-sm">
                  <thead className="border-b border-border-subtle text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Target model</th>
                      <th className="px-3 py-2 font-semibold">Payload</th>
                      <th className="px-3 py-2 font-semibold">Source</th>
                      <th className="px-3 py-2 text-right font-semibold">Expected</th>
                      <th className="px-3 py-2 font-semibold">Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.map((c) => (
                      <tr
                        key={`${c.model}::${c.payloadId}`}
                        className="border-b border-border-subtle/50 last:border-0"
                      >
                        <td className="px-3 py-2 font-mono">{c.model}</td>
                        <td className="px-3 py-2 font-mono">{c.payloadId}</td>
                        <td className="px-3 py-2 font-mono text-[10px] text-text-muted">
                          {c.sourceModel}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{c.expectedScore}</td>
                        <td className="px-3 py-2">
                          <Badge variant="warning" size="sm">
                            {c.confidence}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-[10px] text-text-muted">
            Expected score is the source model&apos;s result carried over as an expectation, not a
            measurement. Nothing here is recorded until the Benchmark tab runs it. A zero score never
            transfers — spending calls to confirm a known failure is waste.
          </p>
        </>
      )}
    </div>
  );
}
