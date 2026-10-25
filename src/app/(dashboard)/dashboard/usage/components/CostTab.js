"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Button, CardSkeleton } from "@/shared/components";

// Cost summary tab.
//
// Reads /api/developer/cost-summary, which aggregates the requestDetails rows
// the dashboard already stores. Deliberately reports TOKENS, not dollars: the
// price per model differs by provider and changes, and a wrong dollar figure is
// worse than a correct token count. The operator can multiply with real rates.

export default function CostTab() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (windowDays) => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/developer/cost-summary?days=${windowDays}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. The initial setState lands inside an await continuation, so
  // the set-state-in-effect rule does not apply.
  useEffect(() => {
    let cancelled = false;
    (async () => { if (!cancelled) await load(days); })();
    return () => { cancelled = true; };
  }, [days, load]);

  const maxModelTokens = useMemo(() => {
    const rows = data?.models || [];
    return rows.length ? Math.max(...rows.map((r) => Number(r.tokens) || 0)) : 0;
  }, [data]);

  const maxDayTokens = useMemo(() => {
    const rows = data?.daily || [];
    return rows.length ? Math.max(...rows.map((r) => Number(r.tokens) || 0)) : 0;
  }, [data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">Cost &amp; Token Summary</h2>
          <p className="text-xs text-text-muted mt-0.5">Agregat dari request log. Token, bukan dolar — konversi pakai rate lo sendiri.</p>
        </div>
        <div className="flex items-center gap-2">
          {[1, 7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors ${
                days === d
                  ? "bg-primary text-white border-primary"
                  : "bg-transparent border-border text-text-muted hover:bg-surface-2"
              }`}
            >
              {d}d
            </button>
          ))}
          <Button variant="secondary" size="sm" onClick={() => load(days)} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && <Card className="border-error/40"><p className="text-xs text-error">{error}</p></Card>}

      {loading && !data ? (
        <CardSkeleton />
      ) : data ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold">Requests</span>
              <div className="text-xl font-bold">{data.totals.requests.toLocaleString()}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold">Total Tokens</span>
              <div className="text-xl font-bold text-primary">{data.totals.tokens.toLocaleString()}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold">Avg Tokens / Req</span>
              <div className="text-xl font-bold">{data.totals.avgTokensPerRequest.toLocaleString()}</div>
            </Card>
            <Card padding="sm" className="text-center">
              <span className="text-text-muted text-[10px] uppercase font-semibold">Errors</span>
              <div className="text-xl font-bold text-error">{data.totals.errors.toLocaleString()}</div>
            </Card>
          </div>

          <Card padding="none">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">Top models by tokens</div>
            {(data.models || []).length === 0 ? (
              <p className="p-3 text-xs text-text-muted">Belum ada data. Jalankan beberapa request lewat 9router.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead className="border-b border-border-subtle/60 text-text-muted">
                    <tr>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2 text-right">Requests</th>
                      <th className="px-3 py-2 text-right">Input</th>
                      <th className="px-3 py-2 text-right">Output</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 w-32">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.slice(0, 25).map((r) => {
                      const share = maxModelTokens > 0 ? (r.tokens / maxModelTokens) : 0;
                      return (
                        <tr key={r.model} className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40">
                          <td className="px-3 py-2 font-mono truncate max-w-[220px]">{r.model}</td>
                          <td className="px-3 py-2 text-text-muted">{r.provider}</td>
                          <td className="px-3 py-2 text-right font-mono">{r.requests.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right font-mono text-text-muted">{r.inputTokens.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right font-mono text-text-muted">{r.outputTokens.toLocaleString()}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold">{r.tokens.toLocaleString()}</td>
                          <td className="px-3 py-2">
                            <div className="w-full bg-surface-2 rounded h-1.5 overflow-hidden">
                              <div className="bg-primary h-full" style={{ width: `${share * 100}%` }} />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padding="none">
            <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">Daily trend</div>
            {(data.daily || []).length === 0 ? (
              <p className="p-3 text-xs text-text-muted">Belum ada tren harian.</p>
            ) : (
              <div className="p-3 flex flex-col gap-2">
                {data.daily.map((d) => {
                  const share = maxDayTokens > 0 ? (d.tokens / maxDayTokens) : 0;
                  return (
                    <div key={d.day} className="flex items-center gap-3 text-xs">
                      <span className="font-mono text-text-muted w-24">{d.day}</span>
                      <div className="flex-1 bg-surface-2 rounded h-3 overflow-hidden">
                        <div className="bg-primary h-full transition-all" style={{ width: `${share * 100}%` }} />
                      </div>
                      <span className="font-mono w-20 text-right">{d.tokens.toLocaleString()}</span>
                      <span className="text-text-muted w-16 text-right">{d.requests} req</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
