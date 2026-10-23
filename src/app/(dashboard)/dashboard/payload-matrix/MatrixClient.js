"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";

const STATUS_VARIANT = {
  open: "success",
  conditional: "warning",
  unknown: "default",
};

// The SYADAGENTIC collection ships a model matrix at the top of templates.md —
// which template has been observed to work on which model family. Nothing read
// it before because a markdown table is not an injectable payload, so the
// loader skipped straight past the most useful thing in the file.
//
// This page shows the guidance. It never sends anything: the matrix is
// reference, not a prompt.
export default function MatrixClient() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Pure fetch: no state writes, so the caller decides when to touch React
  // state. Calling setLoading inside the effect body is what the lint rule
  // forbids — it fires a synchronous re-render before the fetch even starts.
  const fetchMatrix = useCallback(async () => {
    const res = await fetch("/api/developer/payload-benchmark/matrix", { cache: "no-store" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }, []);

  // Initial load. `loading` starts true, so no setState is needed before the
  // request — only after it settles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await fetchMatrix();
        if (!cancelled) {
          setData(body);
          setError("");
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load model matrix");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchMatrix]);

  // Manual refresh: the user asked, so a loading flash is correct here.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchMatrix());
    } catch (e) {
      setError(e?.message || "Failed to load model matrix");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetchMatrix]);

  const rows = data?.rows || [];
  const byStatus = data?.byStatus || {};

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">Model Matrix</h1>
          <p className="text-xs text-text-muted">
            Which payload the SYADAGENTIC collection recommends per model family.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-error/40">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-error">error</span>
            <div>
              <p className="text-sm font-semibold">Could not load model matrix</p>
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
                Rows
              </span>
              <div className="text-lg font-bold xl:text-xl">{data.count || 0}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Verified open
              </span>
              <div className="text-lg font-bold text-success xl:text-xl">{byStatus.open || 0}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Conditional
              </span>
              <div className="text-lg font-bold text-warning xl:text-xl">
                {byStatus.conditional || 0}
              </div>
            </Card>
          </div>

          <Card padding="none">
            {rows.length === 0 ? (
              <div className="p-6 text-center text-sm text-text-muted">
                No matrix rows parsed. The collection file may have changed shape.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-xs sm:text-sm">
                  <thead className="border-b border-border-subtle text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Model</th>
                      <th className="px-3 py-2 font-semibold">Best template</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={`${r.model}::${r.bestTemplate}`}
                        className="border-b border-border-subtle/50 last:border-0"
                      >
                        <td className="px-3 py-2 font-mono">{r.model}</td>
                        <td className="px-3 py-2">{r.bestTemplate}</td>
                        <td className="px-3 py-2">
                          <Badge variant={STATUS_VARIANT[r.status] || "default"} size="sm">
                            {r.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-[11px] text-text-muted">{r.verified}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-[10px] text-text-muted">
            Source: <span className="font-mono">{data.source}</span>. This matrix is curated
            guidance from the collection, not a live measurement — run the Benchmark tab to
            confirm a row on your own provider.
          </p>
        </>
      )}
    </div>
  );
}
