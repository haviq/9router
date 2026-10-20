"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Badge, Button, SegmentedControl, CardSkeleton } from "@/shared/components";

const WINDOWS = [
  { value: "1", label: "1H" },
  { value: "6", label: "6H" },
  { value: "24", label: "24H" },
  { value: "72", label: "3D" },
  { value: "168", label: "7D" },
];

const pct = (v) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
const ms = (v) =>
  v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
const num = (v) => new Intl.NumberFormat().format(v || 0);

// A provider with no traffic in the window is unused, not down — never paint it red.
function rateVariant(rate) {
  if (rate === null || rate === undefined) return "default";
  if (rate >= 0.98) return "success";
  if (rate >= 0.9) return "warning";
  return "error";
}

export default function ProviderHealth() {
  const [hours, setHours] = useState("24");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  // Pure fetch: no state writes, so callers decide when to touch React state.
  const fetchHealth = useCallback(async (windowHours) => {
    const res = await fetch(`/api/providers/health?hours=${windowHours}`, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  // Manual refresh: the user asked, so a loading flash is correct here.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchHealth(hours));
      setRefreshedAt(new Date());
    } catch (e) {
      setError(e?.message || "Failed to load provider health");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetchHealth, hours]);

  // Window change / mount: every state write happens after an await, which
  // keeps the effect from triggering the cascading-render lint rule.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchHealth(hours);
        if (cancelled) return;
        setData(next);
        setRefreshedAt(new Date());
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load provider health");
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hours, fetchHealth]);

  const totals = data?.totals;
  const providers = data?.providers || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold sm:text-xl">Provider Health</h1>
          <p className="text-xs text-text-muted sm:text-sm">
            Success rate and latency per provider, from recorded requests.
            {refreshedAt && <span className="ml-1">Updated {refreshedAt.toLocaleTimeString()}.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl options={WINDOWS} value={hours} onChange={setHours} size="sm" />
          <Button variant="secondary" size="sm" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-error/40">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined text-error">error</span>
            <div>
              <p className="text-sm font-semibold">Could not load provider health</p>
              <p className="text-xs text-text-muted">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {loading && !data && <CardSkeleton />}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">Requests</span>
              <div className="text-lg font-bold xl:text-xl">{num(totals?.total)}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">Success Rate</span>
              <div className="text-lg font-bold xl:text-xl">
                <Badge variant={rateVariant(totals?.successRate)} size="lg">
                  {pct(totals?.successRate)}
                </Badge>
              </div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">Failed</span>
              <div className="text-lg font-bold text-error xl:text-xl">{num(totals?.failed)}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">Providers</span>
              <div className="text-lg font-bold xl:text-xl">{num(totals?.providerCount)}</div>
            </Card>
          </div>

          <Card padding="none">
            {providers.length === 0 ? (
              <div className="p-6 text-center text-sm text-text-muted">
                No requests recorded in the last {data.windowHours}h. Enable request logging in
                Settings → Observability to populate this view.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs sm:text-sm">
                  <thead className="border-b border-border-subtle text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Provider</th>
                      <th className="px-3 py-2 text-right font-semibold">Requests</th>
                      <th className="px-3 py-2 text-right font-semibold">OK</th>
                      <th className="px-3 py-2 text-right font-semibold">Failed</th>
                      <th className="px-3 py-2 text-right font-semibold">Success</th>
                      <th className="px-3 py-2 text-right font-semibold">p50</th>
                      <th className="px-3 py-2 text-right font-semibold">p95</th>
                      <th className="px-3 py-2 text-right font-semibold">Max</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => (
                      <tr key={p.provider} className="border-b border-border-subtle/50 last:border-0">
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.name || p.provider}</div>
                          {p.name && p.name !== p.provider && (
                            <div className="text-[10px] text-text-muted">{p.provider}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(p.total)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-success">{num(p.ok)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-error">{num(p.failed)}</td>
                        <td className="px-3 py-2 text-right">
                          <Badge variant={rateVariant(p.successRate)} size="sm">
                            {pct(p.successRate)}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{ms(p.latency?.p50)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{ms(p.latency?.p95)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{ms(p.latency?.max)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-[10px] text-text-muted">
            Counts are exact for the window. Latency percentiles come from the most recent{" "}
            {num(data.sampledRows)} request{data.sampledRows === 1 ? "" : "s"} parsed (cap{" "}
            {num(data.latencySampleCap)}), so a p95 on a very busy provider is a sample, not a
            census.
          </p>
        </>
      )}
    </div>
  );
}
