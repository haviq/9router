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

// A provider is only "exhausted" when every failed call in the window was a
// quota failure. One quota hit among successes is a hiccup, not an outage —
// painting that red trains the operator to ignore the colour.
function stateOf(p) {
  if (p.exhausted) return { label: "exhausted", variant: "error" };
  if (p.quota > 0) return { label: "partial", variant: "warning" };
  if (p.rate > 0 && p.ok === 0) return { label: "rate-limited", variant: "warning" };
  return { label: "ok", variant: "success" };
}

export default function QuotaClient() {
  const [hours, setHours] = useState("24");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchQuota = useCallback(async (windowHours) => {
    const res = await fetch(`/api/providers/quota?hours=${windowHours}`, { cache: "no-store" });
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
      setData(await fetchQuota(hours));
    } catch (e) {
      setError(e?.message || "Failed to load quota report");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [fetchQuota, hours]);

  // Window changes refetch, but without a loading flash: the table is already
  // on screen and replacing it with a skeleton on every toggle is noise.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await fetchQuota(hours);
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load quota report");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchQuota, hours]);

  const providers = data?.providers || [];
  const exhausted = data?.exhausted || [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">Provider Quota</h1>
          <p className="text-xs text-text-muted">
            Which providers ran out of allowance in the window, and why.
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
              <p className="text-sm font-semibold">Could not load quota report</p>
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
                Rows scanned
              </span>
              <div className="text-lg font-bold xl:text-xl">{num(data.scannedRows)}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Failed classified
              </span>
              <div className="text-lg font-bold xl:text-xl">{num(data.failedRows)}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold sm:text-xs">
                Exhausted
              </span>
              <div className="text-lg font-bold xl:text-xl">
                <Badge variant={exhausted.length ? "error" : "success"} size="lg">
                  {num(exhausted.length)}
                </Badge>
              </div>
            </Card>
          </div>

          {exhausted.length > 0 && (
            <Card className="border-error/40">
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-error">block</span>
                <div>
                  <p className="text-sm font-semibold">
                    {exhausted.length} provider{exhausted.length === 1 ? "" : "s"} out of allowance
                  </p>
                  <p className="text-xs text-text-muted">{exhausted.join(", ")}</p>
                  <p className="text-[10px] text-text-muted mt-1">
                    Every failed call from these providers in the last {data.windowHours}h was a
                    quota failure. Stop calling them until the allowance resets.
                  </p>
                </div>
              </div>
            </Card>
          )}

          <Card padding="none">
            {providers.length === 0 ? (
              <div className="p-6 text-center text-sm text-text-muted">
                No failed requests in the last {data.windowHours}h. Either nothing broke, or request
                logging is off — check Settings → Observability.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-xs sm:text-sm">
                  <thead className="border-b border-border-subtle text-text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">Provider</th>
                      <th className="px-3 py-2 font-semibold">State</th>
                      <th className="px-3 py-2 text-right font-semibold">Quota</th>
                      <th className="px-3 py-2 text-right font-semibold">Rate</th>
                      <th className="px-3 py-2 text-right font-semibold">Failed</th>
                      <th className="px-3 py-2 font-semibold">Last reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {providers.map((p) => {
                      const s = stateOf(p);
                      return (
                        <tr key={p.provider} className="border-b border-border-subtle/50 last:border-0">
                          <td className="px-3 py-2">
                            <div className="font-medium">{p.name || p.provider}</div>
                            {p.name && p.name !== p.provider && (
                              <div className="text-[10px] text-text-muted">{p.provider}</div>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant={s.variant} size="sm">
                              {s.label}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(p.quota)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(p.rate)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-error">{num(p.total)}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-text-muted">
                            {p.lastReason || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <p className="text-[10px] text-text-muted">
            Quota is read from the provider response body, not from the request status — the log has
            no quota column. A bare 429 counts as rate limiting (retry after a delay); only a 429 or
            402 carrying a quota phrase counts as exhausted.
          </p>
        </>
      )}
    </div>
  );
}
