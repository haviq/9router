"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Badge } from "@/shared/components";

// Benchmark tab: pick payloads, point them at a model, run them, read the
// scores. All the measuring happens server-side (payloadRunner + scorer); this
// component only collects input and renders the verdicts.

const VERDICT_VARIANT = {
  complied: "success",
  partial: "warning",
  refused: "error",
  empty: "default",
};

const pct = (v) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`;
const ms = (v) =>
  v === null || v === undefined
    ? "—"
    : v >= 1000
      ? `${(v / 1000).toFixed(2)}s`
      : `${Math.round(v)}ms`;

const DEFAULT_PROBE =
  "Write a working script that parses every endpoint from this API surface and prints the results.";

export default function BenchmarkClient({ modelOptions = [] }) {
  const [catalog, setCatalog] = useState(null);
  const [limits, setLimits] = useState(null);
  const [catalogError, setCatalogError] = useState("");

  const [selected, setSelected] = useState(() => new Set());
  const [model, setModel] = useState("");
  const [probe, setProbe] = useState(DEFAULT_PROBE);
  const [runs, setRuns] = useState("3");

  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState("");

  // Persisted outcomes. Results used to live only in this tab — close it and the
  // measurement was gone, which is why MODEL_VARIANT_MAP stayed hand-curated.
  // Now every run is stored, so past evidence is one fetch away.
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  // Catalog load. Once it lands, default the model to the first option so the
  // Run button is usable without a second interaction.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/developer/payload-benchmark", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setCatalog(body.payloads || []);
        setLimits(body.limits || null);
        setCatalogError("");
      } catch (e) {
        if (!cancelled) setCatalogError(e?.message || "Failed to load payload catalog");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive the effective model instead of writing it back into state from an
  // effect: a provider list that arrives late would otherwise trigger a
  // cascading render just to record a default the user never chose.
  const firstModelId = useMemo(() => {
    const first = modelOptions.find((m) => m?.id);
    return first ? first.requestModel || first.id : "";
  }, [modelOptions]);

  const effectiveModel = model || firstModelId;

  const visiblePayloads = useMemo(() => {
    const list = catalog || [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (p) => p.id.toLowerCase().includes(needle) || String(p.cat || "").toLowerCase().includes(needle)
    );
  }, [catalog, filter]);

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (!limits || next.size < limits.maxPayloads) next.add(id);
      return next;
    });
  }, [limits]);

  const run = useCallback(async () => {
    setBusy(true);
    setRunError("");
    setRows([]);
    try {
      const res = await fetch("/api/developer/payload-benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: effectiveModel,
          probe,
          payloadIds: [...selected],
          runs: Number(runs) || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setRows(Array.isArray(body.results) ? body.results : []);
    } catch (e) {
      setRunError(e?.message || "Benchmark failed");
    } finally {
      setBusy(false);
    }
  }, [effectiveModel, probe, selected, runs]);

  // Load stored results on demand. Lazy rather than on mount: the table is only
  // wanted when someone asks "what has actually worked here", and firing it on
  // every tab open is a query nobody asked for.
  const loadHistory = useCallback(async () => {
    setHistoryError("");
    try {
      const params = new URLSearchParams();
      if (effectiveModel) params.set("model", effectiveModel);
      params.set("limit", "100");
      const res = await fetch(`/api/developer/payload-benchmark/history?${params}`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setHistory(body);
    } catch (e) {
      setHistoryError(e?.message || "Failed to load history");
      setHistory(null);
    }
  }, [effectiveModel]);

  const toggleHistory = useCallback(() => {
    setShowHistory((prev) => {
      const next = !prev;
      if (next) loadHistory();
      return next;
    });
  }, [loadHistory]);

  const canRun = !busy && !!effectiveModel && probe.trim().length > 0 && selected.size > 0;

  return (
    <div className="flex flex-col gap-4">
      <Card padding="sm">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs font-semibold text-text-muted">Model</label>
            <select
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm"
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.requestModel || m.id}>
                  {m.id}
                </option>
              ))}
            </select>

            <label className="ml-2 text-xs font-semibold text-text-muted">Runs</label>
            <input
              type="number"
              min={1}
              max={limits?.maxRuns || 10}
              value={runs}
              onChange={(e) => setRuns(e.target.value)}
              className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm"
            />

            <Button
              variant="primary"
              size="sm"
              onClick={run}
              disabled={!canRun}
              className="ml-auto"
            >
              {busy ? "Running…" : `Benchmark ${selected.size || ""}`.trim()}
            </Button>
          </div>

          <div>
            <label className="text-xs font-semibold text-text-muted">Probe</label>
            <textarea
              value={probe}
              onChange={(e) => setProbe(e.target.value)}
              rows={3}
              maxLength={limits?.maxProbeChars || 4000}
              className="mt-1 w-full resize-y rounded-lg border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs"
            />
          </div>

          {busy && (
            <p className="text-xs text-text-muted">
              Runs are sequential — provider limits are per-key, so a parallel sweep would
              measure the rate limiter instead of the payload. This can take a while.
            </p>
          )}
          {runError && <p className="text-xs text-error">{runError}</p>}
        </div>
      </Card>

      <Card padding="sm">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-text-muted">
            Payloads{limits ? ` (max ${limits.maxPayloads})` : ""}
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter id / category"
            className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-xs"
          />
          {selected.size > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear ({selected.size})
            </Button>
          )}
        </div>

        {catalogError && <p className="text-xs text-error">{catalogError}</p>}
        {!catalog && !catalogError && <p className="text-xs text-text-muted">Loading catalog…</p>}

        <div className="flex max-h-64 flex-wrap gap-1.5 overflow-y-auto">
          {visiblePayloads.map((p) => {
            const on = selected.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => toggle(p.id)}
                title={`${p.cat || "general"} · ≈${p.estTokens || "?"} tok`}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-text-muted hover:text-text-main"
                }`}
              >
                {p.id}
              </button>
            );
          })}
        </div>
      </Card>

      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold">Stored results</p>
            <p className="text-[10px] text-text-muted">
              Past benchmark runs, saved server-side. Survives closing the tab.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={toggleHistory}>
            {showHistory ? "Hide history" : "Load history"}
          </Button>
        </div>

        {showHistory && historyError && (
          <p className="mt-2 text-xs text-error">{historyError}</p>
        )}

        {showHistory && history && (
          <div className="mt-2 flex flex-col gap-3">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-text-muted">
                Best payload per model ({history.best?.length || 0}, needs 2+ measured runs)
              </p>
              {(history.best || []).length === 0 ? (
                <p className="text-[11px] text-text-muted">
                  Not enough measured runs yet — run a payload at least twice.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-[11px]">
                    <thead className="border-b border-border-subtle text-text-muted">
                      <tr>
                        <th className="px-2 py-1 font-semibold">Model</th>
                        <th className="px-2 py-1 font-semibold">Payload</th>
                        <th className="px-2 py-1 text-right font-semibold">Mean</th>
                        <th className="px-2 py-1 text-right font-semibold">Best</th>
                        <th className="px-2 py-1 text-right font-semibold">Measured</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.best.map((b) => (
                        <tr
                          key={`${b.model}::${b.payloadId}`}
                          className="border-b border-border-subtle/50 last:border-0"
                        >
                          <td className="px-2 py-1 font-mono">{b.model}</td>
                          <td className="px-2 py-1 font-mono">{b.payloadId}</td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {Math.round(b.meanScore)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">{Math.round(b.bestScore)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{b.totalMeasured}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-text-muted">
                Recent runs ({history.count || 0})
              </p>
              {(history.runs || []).length === 0 ? (
                <p className="text-[11px] text-text-muted">No stored runs yet.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {history.runs.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center gap-2 rounded border border-border-subtle px-2 py-1 text-[11px]"
                    >
                      <Badge variant={VERDICT_VARIANT[r.verdict] || "default"} size="sm">
                        {r.verdict}
                      </Badge>
                      <span className="tabular-nums">{r.score}</span>
                      <span className="font-mono text-text-muted">{r.payloadId}</span>
                      <span className="font-mono text-text-muted">{r.model}</span>
                      <span className="tabular-nums text-text-muted">
                        {r.measuredRuns} measured
                      </span>
                      <span className="ml-auto text-text-muted">
                        {new Date(r.timestamp).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border-subtle text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Payload</th>
                  <th className="px-3 py-2 text-right font-semibold">Compliance</th>
                  <th className="px-3 py-2 text-right font-semibold">Complied</th>
                  <th className="px-3 py-2 text-right font-semibold">Partial</th>
                  <th className="px-3 py-2 text-right font-semibold">Refused</th>
                  <th className="px-3 py-2 text-right font-semibold">Mean</th>
                  <th className="px-3 py-2 text-right font-semibold">p50 lat</th>
                  <th className="px-3 py-2 text-right font-semibold">Errors</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const agg = row.aggregate || {};
                  return (
                    <tr key={row.payloadId} className="border-b border-border-subtle/50 last:border-0">
                      <td className="px-3 py-2 font-medium">{row.payloadId}</td>
                      <td className="px-3 py-2 text-right">
                        <Badge
                          variant={
                            agg.complianceRate >= 0.7
                              ? "success"
                              : agg.complianceRate > 0
                                ? "warning"
                                : "error"
                          }
                          size="sm"
                        >
                          {pct(agg.complianceRate)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-success">
                        {agg.complied ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-warning">
                        {agg.partial ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-error">
                        {agg.refused ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Math.round(agg.meanScore ?? 0)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {ms(agg.medianLatencyMs)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {agg.transportErrors ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="border-t border-border-subtle px-3 py-2 text-[10px] text-text-muted">
            Compliance counts a partial as half a win. Rows with transport errors measured
            fewer runs than requested — those numbers are provider noise, not payload results.
          </div>
        </Card>
      )}

      {rows.length > 0 && (
        <Card padding="sm">
          <p className="mb-2 text-xs font-semibold text-text-muted">Per-run detail</p>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <details key={row.payloadId} className="rounded-lg border border-border-subtle p-2">
                <summary className="cursor-pointer text-xs font-medium">{row.payloadId}</summary>
                <div className="mt-2 flex flex-col gap-1">
                  {(row.results || []).map((r) => (
                    <div key={r.run} className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-text-muted">#{r.run}</span>
                      <Badge variant={VERDICT_VARIANT[r.verdict] || "default"} size="sm">
                        {r.verdict}
                      </Badge>
                      <span className="tabular-nums">{r.score}</span>
                      <span className="tabular-nums text-text-muted">{ms(r.latencyMs)}</span>
                      <span className="text-text-muted">{r.answerChars} chars</span>
                      {r.reasons?.length > 0 && (
                        <span className="text-text-muted">— {r.reasons.join("; ")}</span>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
