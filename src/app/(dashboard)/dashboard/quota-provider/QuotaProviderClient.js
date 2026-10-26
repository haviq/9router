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

const num = (v) => new Intl.NumberFormat().format(v || 0);

// A provider is only "exhausted" when every failure was quota and NO request
// succeeded. Any success in the window proves the account still works.
function stateOf(p) {
  if (p.exhausted) return { label: "exhausted", variant: "error" };
  if (p.quota > 0 && p.success > 0) return { label: "partial", variant: "warning" };
  if (p.rate > 0 && p.success === 0) return { label: "rate-limited", variant: "warning" };
  return { label: "ok", variant: "success" };
}

function relTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (!Number.isFinite(d)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Per-provider load over the request log. Distinct from /dashboard/quota
// (which shows per-account quota bars). This page answers "who is handling the
// traffic, and how cleanly" — one row per provider prefix.
export default function QuotaProviderClient() {
  const [hours, setHours] = useState("24");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchSummary = useCallback(async (windowHours) => {
    const res = await fetch(`/api/providers/quota-summary?hours=${windowHours}`, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchSummary(hours));
    } catch (e) {
      setError(e?.message || "Failed to load provider summary");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetchSummary, hours]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchSummary(hours);
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load provider summary");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [fetchSummary, hours]);

  const counters = data?.counters || {};
  const providers = data?.providers || [];

  return (
    <div className="flex min-w-0 flex-col gap-4 px-1 sm:px-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Provider Load</h1>
          <p className="text-xs text-text-muted mt-0.5">
            Per-provider request breakdown over the request log. Every call counts, success and failure alike.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl options={WINDOWS} value={hours} onChange={setHours} />
          <Button variant="secondary" size="sm" icon="refresh" onClick={refresh} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Card padding="sm">
          <p className="text-sm text-red-500">{error}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card padding="sm">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Providers</div>
          <div className="text-xl font-bold text-text-main mt-0.5">{num(counters.total)}</div>
        </Card>
        <Card padding="sm">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Healthy</div>
          <div className="text-xl font-bold text-emerald-500 mt-0.5">{num(counters.healthy)}</div>
        </Card>
        <Card padding="sm">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Rate-limited</div>
          <div className="text-xl font-bold text-amber-500 mt-0.5">{num(counters.rateLimited)}</div>
        </Card>
        <Card padding="sm">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">Exhausted</div>
          <div className="text-xl font-bold text-red-500 mt-0.5">{num(counters.exhausted)}</div>
        </Card>
      </div>

      {loading && !data ? (
        <CardSkeleton />
      ) : providers.length === 0 ? (
        <Card padding="sm">
          <p className="text-sm text-text-muted">
            No provider traffic in this window. Make a request through the gateway and refresh.
          </p>
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wide text-text-muted">
                  <th className="text-left px-3 py-2">Provider</th>
                  <th className="text-right px-3 py-2">Total</th>
                  <th className="text-right px-3 py-2">Success</th>
                  <th className="text-right px-3 py-2">Quota</th>
                  <th className="text-right px-3 py-2">Rate</th>
                  <th className="text-right px-3 py-2">Other</th>
                  <th className="text-right px-3 py-2">Success rate</th>
                  <th className="text-right px-3 py-2">State</th>
                  <th className="text-right px-3 py-2">Last seen</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {providers.map((p) => {
                  const st = stateOf(p);
                  const other = (p.other || 0) + (p.unknown || 0);
                  return (
                    <tr key={p.provider} className="border-b border-border/50 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
                      <td className="px-3 py-2 font-semibold text-text-main truncate max-w-[220px]" title={p.rawProviders?.length > 1 ? p.rawProviders.join(", ") : p.provider}>
                        {p.provider}
                      </td>
                      <td className="px-3 py-2 text-right">{num(p.total)}</td>
                      <td className="px-3 py-2 text-right text-emerald-500">{num(p.success)}</td>
                      <td className="px-3 py-2 text-right text-red-500">{p.quota ? num(p.quota) : "—"}</td>
                      <td className="px-3 py-2 text-right text-amber-500">{p.rate ? num(p.rate) : "—"}</td>
                      <td className="px-3 py-2 text-right text-text-muted">{other ? num(other) : "—"}</td>
                      <td className="px-3 py-2 text-right font-semibold">{Math.round((p.successRate || 0) * 100)}%</td>
                      <td className="px-3 py-2 text-right"><Badge variant={st.variant}>{st.label}</Badge></td>
                      <td className="px-3 py-2 text-right text-text-muted">{relTime(p.lastSeen)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {data?.scannedRows != null && (
        <p className="text-[10px] text-text-muted">
          Scanned {num(data.scannedRows)} rows · window {data.windowHours}h · generated {relTime(data.generatedAt)}
        </p>
      )}
    </div>
  );
}
