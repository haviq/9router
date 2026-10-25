"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";
import useLiveModels from "@/shared/hooks/useLiveModels";

export default function ModelStatusClient() {
  const { models: fallbackModels, loading: modelsLoading, error: modelsError } = useLiveModels();
  const [serverActiveModels, setServerActiveModels] = useState([]);
  const [probeResults, setProbeResults] = useState({});
  const [providerNodes, setProviderNodes] = useState([]);
  const [running, setRunning] = useState(false);
  const [selectedModel, setSelectedModel] = useState(null);
  const [search, setSearch] = useState("");
  const [concurrency, setConcurrency] = useState(4);
  // Auto-refresh interval in seconds. 0 = off. Only the currently visible
  // slice is pinged (capped) so a 5-minute sweep never fires 648 upstream
  // requests and never bills a token for models the operator is not looking at.
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(30);
  const refreshTimerRef = useRef(null);
  const [expandedProvider, setExpandedProvider] = useState(null);
  const cancelRef = useRef(false);

  // Load cached status & active models & provider nodes on mount
  useEffect(() => {
    (async () => {
      try {
        const [resProbe, resNodes] = await Promise.all([
          fetch("/api/models/probe-matrix", { cache: "no-store" }),
          fetch("/api/provider-nodes", { cache: "no-store" }).catch(() => null),
        ]);

        if (resProbe?.ok) {
          const data = await resProbe.json();
          if (Array.isArray(data.activeModels) && data.activeModels.length > 0) {
            setServerActiveModels(data.activeModels);
          }
          if (Array.isArray(data.results)) {
            const map = {};
            data.results.forEach((r) => {
              map[r.id] = r;
            });
            setProbeResults(map);
          }
        }

        if (resNodes?.ok) {
          const nodes = await resNodes.json();
          if (Array.isArray(nodes)) setProviderNodes(nodes);
        }
      } catch {}
    })();
  }, []);

  // Gunakan serverActiveModels (648 model asli aktif), fallback ke raw live models
  const rawLiveModels = serverActiveModels.length > 0 ? serverActiveModels : fallbackModels;

  // Mapping UUID node id -> prefix yang bersih (kl, ifx, mg, ar, cn, dll)
  const nodePrefixMap = useMemo(() => {
    const map = {};
    providerNodes.forEach((node) => {
      if (!node) return;
      const prefix = node.prefix || node.name || "";
      if (node.id) map[node.id.toLowerCase()] = prefix.toLowerCase();
    });
    return map;
  }, [providerNodes]);

  // Normalisasi model ID agar prefix tampil bersih dan rapi (misal kl/model bukan UUID/model)
  const liveModels = useMemo(() => {
    return rawLiveModels.map((m) => {
      let id = m.id || m.routedModel || m.fullModel || "";
      let displayProv = "direct";

      if (id.includes("/")) {
        const parts = id.split("/");
        const rawProv = parts[0];
        const rest = parts.slice(1).join("/");
        const mapped = nodePrefixMap[rawProv.toLowerCase()];

        if (mapped) {
          displayProv = mapped;
          id = `${mapped}/${rest}`;
        } else {
          displayProv = rawProv;
        }
      } else if (m.provider) {
        const mapped = nodePrefixMap[m.provider.toLowerCase()];
        displayProv = mapped || m.provider;
      }

      return {
        ...m,
        id,
        cleanProvider: displayProv,
      };
    });
  }, [rawLiveModels, nodePrefixMap]);

  // Single model probe
  const pingOne = useCallback(async (modelItem) => {
    const id = modelItem.id || modelItem.model;
    setProbeResults((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), id, checking: true },
    }));

    try {
      const res = await fetch("/api/models/probe-matrix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: id, kind: modelItem.kind || "llm" }),
      });
      const data = await res.json();
      setProbeResults((prev) => ({
        ...prev,
        [id]: { ...data, checking: false },
      }));
      setSelectedModel((cur) => (cur?.id === id ? { ...data, checking: false } : cur));
    } catch (err) {
      const failed = {
        id,
        ok: false,
        status: 500,
        latencyMs: 0,
        error: err.message,
        checking: false,
        testedAt: new Date().toISOString(),
      };
      setProbeResults((prev) => ({
        ...prev,
        [id]: failed,
      }));
      setSelectedModel((cur) => (cur?.id === id ? failed : cur));
    }
  }, []);

  // Batch probe execution
  const startBatch = useCallback(
    async (targets) => {
      if (running || !targets.length) return;
      setRunning(true);
      cancelRef.current = false;

      const queue = [...targets];
      const limit = Math.max(1, Math.min(8, Number(concurrency) || 4));

      async function worker() {
        while (queue.length > 0 && !cancelRef.current) {
          const item = queue.shift();
          if (!item) break;
          await pingOne(item);
        }
      }

      await Promise.all(Array.from({ length: limit }, worker));
      setRunning(false);
    },
    [running, concurrency, pingOne]
  );

  // Auto-refresh the visible slice. A full 648-model sweep takes minutes and
  // bills a token per seat; the operator is watching a filter, so only what is
  // on screen is re-pinged, capped at 21 per tick. Skipped while a manual batch
  // is already running so the two do not interleave. Grouped data is read via a
  // ref because the effect is declared before `grouped` exists in source order.
  const groupedRef = useRef([]);

  useEffect(() => {
    if (!refreshIntervalSec || running) return;
    const ms = refreshIntervalSec * 1000;

    const tick = async () => {
      if (cancelRef.current) return;
      const visible = (groupedRef.current || []).slice(0, 3).flatMap((g) => g.models.slice(0, 7));
      for (const m of visible) await pingOne(m);
    };

    refreshTimerRef.current = setInterval(tick, ms);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [refreshIntervalSec, running, pingOne]);

  const stopBatch = useCallback(() => {
    cancelRef.current = true;
    setRunning(false);
  }, []);

  // Group models by provider with stats & SORTING HIJAU DI ATAS
  const grouped = useMemo(() => {
    const groups = {};
    const query = search.trim().toLowerCase();

    liveModels.forEach((m) => {
      const prov = m.cleanProvider || (m.id.includes("/") ? m.id.split("/")[0] : "direct");
      const idLower = m.id.toLowerCase();
      const provLower = prov.toLowerCase();

      // Search matches model id, clean provider name, or prefix
      if (query && !idLower.includes(query) && !provLower.includes(query)) return;

      if (!groups[prov]) {
        groups[prov] = { provider: prov, models: [], ok: 0, error: 0, untested: 0 };
      }
      groups[prov].models.push(m);

      const r = probeResults[m.id];
      if (!r) groups[prov].untested++;
      else if (r.ok) groups[prov].ok++;
      else groups[prov].error++;
    });

    // Di dalam tiap grup, urutkan kotak model: HIJAU (OK) di depan!
    Object.values(groups).forEach((g) => {
      g.models.sort((a, b) => {
        const resA = probeResults[a.id];
        const resB = probeResults[b.id];
        const scoreA = resA?.ok ? 3 : resA?.checking ? 2 : !resA ? 1 : 0;
        const scoreB = resB?.ok ? 3 : resB?.checking ? 2 : !resB ? 1 : 0;
        return scoreB - scoreA;
      });
    });

    // Sort grup provider: YANG ADA HIJAUNYA PALING BANYAK DI PALING ATAS!
    return Object.values(groups).sort((a, b) => {
      if (b.ok !== a.ok) return b.ok - a.ok; // Hijau terbanyak di atas
      if (a.error !== b.error) return a.error - b.error; // Error lebih sedikit di atas
      return b.models.length - a.models.length;
    });
  }, [liveModels, probeResults, search]);

  // Publish the latest grouping to the ref the auto-refresh timer reads. A ref
  // (not a dependency) because re-creating the interval on every keystroke in
  // the search box would reset the countdown and starve the sweep.
  useEffect(() => {
    groupedRef.current = grouped;
  }, [grouped]);

  // Global aggregate stats
  const globalStats = useMemo(() => {
    let ok = 0;
    let error = 0;
    let untested = 0;
    liveModels.forEach((m) => {
      const r = probeResults[m.id];
      if (!r) untested++;
      else if (r.ok) ok++;
      else error++;
    });
    const tested = ok + error;
    const ratio = tested > 0 ? Math.round((ok / tested) * 100) : 0;
    return { total: liveModels.length, ok, error, untested, ratio, tested };
  }, [liveModels, probeResults]);

  return (
    <div className="flex flex-col gap-4">
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">dashboard</span>
            Upstream Status Matrix
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="secondary" size="sm" onClick={stopBatch}>
              <span className="inline-block animate-spin mr-1">⟳</span> Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => startBatch(liveModels)}
              disabled={liveModels.length === 0}
            >
              Check All ({liveModels.length})
            </Button>
          )}
        </div>
      </div>

      {/* Global Overview Bar Card */}
      <Card padding="sm">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-3">
              <span className="font-semibold text-text-main">
                Total: <span className="font-mono">{globalStats.total}</span> models
              </span>
              <span className="flex items-center gap-1.5 text-success">
                <span className="h-2 w-2 rounded-full bg-success" />
                Online: <span className="font-mono font-bold">{globalStats.ok}</span>
              </span>
              <span className="flex items-center gap-1.5 text-error">
                <span className="h-2 w-2 rounded-full bg-error" />
                Error: <span className="font-mono font-bold">{globalStats.error}</span>
              </span>
              <span className="flex items-center gap-1.5 text-text-muted">
                <span className="h-2 w-2 rounded-full bg-border" />
                Untested: <span className="font-mono">{globalStats.untested}</span>
              </span>
            </div>
            <div className="font-mono font-bold text-xs text-primary">
              Health: {globalStats.ratio}%
            </div>
          </div>

          {/* Multi-segment Status Bar */}
          <div className="h-3 w-full rounded-md bg-surface-2 overflow-hidden flex border border-border-subtle p-0.5 gap-0.5">
            {globalStats.ok > 0 && (
              <div
                className="h-full bg-success rounded-sm transition-all duration-300"
                style={{ width: `${(globalStats.ok / globalStats.total) * 100}%` }}
                title={`Online: ${globalStats.ok}`}
              />
            )}
            {globalStats.error > 0 && (
              <div
                className="h-full bg-error rounded-sm transition-all duration-300"
                style={{ width: `${(globalStats.error / globalStats.total) * 100}%` }}
                title={`Error: ${globalStats.error}`}
              />
            )}
            {globalStats.untested > 0 && (
              <div
                className="h-full bg-border rounded-sm transition-all duration-300"
                style={{ width: `${(globalStats.untested / globalStats.total) * 100}%` }}
                title={`Untested: ${globalStats.untested}`}
              />
            )}
          </div>
        </div>
      </Card>

      {/* Controls & Filter Bar */}
      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex-1 min-w-[220px]">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search model ID or provider prefix (e.g. kl, ifx, mg, cn)..."
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main outline-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-text-muted">
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-success" /> OK
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-error" /> Error
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-warning animate-pulse" /> Checking
              </span>
              <span className="flex items-center gap-1" title="Probe missed the 30s window — slow or busy, not dead">
                <span className="h-2.5 w-2.5 rounded-sm bg-warning/70 border border-warning" /> Timeout
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-sm bg-surface-2 border border-border" /> Untested
              </span>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-text-muted">Speed:</span>
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={running}
                className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
              >
                <option value={2}>2x</option>
                <option value={4}>4x (Safe)</option>
                <option value={8}>8x (Fast)</option>
              </select>
            </div>

            <div className="flex items-center gap-1">
              <span className="text-text-muted">Auto:</span>
              <select
                value={refreshIntervalSec}
                onChange={(e) => setRefreshIntervalSec(Number(e.target.value))}
                className="rounded border border-border bg-surface-2 px-2 py-1 text-xs"
                title="Auto-refresh hanya model yang terlihat (max 21 per tick) — hemat token"
              >
                <option value={0}>Off</option>
                <option value={30}>30s</option>
                <option value={60}>1m</option>
                <option value={300}>5m</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* Model Inspector Modal / Drawer if a square is selected */}
      {selectedModel && (
        <Card padding="sm" className="border-primary/40 bg-surface/90">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-sm text-text-main">
                  {selectedModel.id}
                </span>
                {selectedModel.checking ? (
                  <Badge variant="warning" size="sm">
                    pinging...
                  </Badge>
                ) : selectedModel.ok ? (
                  <Badge variant="success" size="sm">
                    200 OK ({selectedModel.latencyMs} ms)
                  </Badge>
                ) : selectedModel.testedAt ? (
                  <Badge variant="error" size="sm">
                    {selectedModel.status || "FAIL"}
                  </Badge>
                ) : (
                  <Badge variant="default" size="sm">
                    Not tested
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="xs"
                  disabled={selectedModel.checking || running}
                  onClick={() => pingOne(selectedModel)}
                >
                  Re-test
                </Button>
                <Button variant="ghost" size="xs" onClick={() => setSelectedModel(null)}>
                  Close
                </Button>
              </div>
            </div>

            {selectedModel.error && (
              <div className="rounded bg-error/10 border border-error/20 p-2 font-mono text-[11px] text-error break-all">
                {selectedModel.error}
              </div>
            )}
            {selectedModel.note && (
              <div className="text-[11px] text-text-muted">Note: {selectedModel.note}</div>
            )}
            {selectedModel.testedAt && (
              <div className="text-[10px] text-text-muted">
                Last tested: {new Date(selectedModel.testedAt).toLocaleTimeString()}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Provider Categorized Grid (GitHub style squares with OK sorted first) */}
      {modelsLoading && !rawLiveModels.length ? (
        <CardSkeleton />
      ) : modelsError && !rawLiveModels.length ? (
        <Card className="border-error/40">
          <p className="text-xs text-error">{modelsError}</p>
        </Card>
      ) : grouped.length === 0 ? (
        <Card padding="sm">
          <p className="text-xs text-text-muted text-center py-4">
            No models found matching &quot;{search}&quot;
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map((group) => {
            const total = group.models.length;
            const ok = group.ok;
            const err = group.error;
            const untested = group.untested;
            const tested = ok + err;
            const groupRatio = tested > 0 ? Math.round((ok / tested) * 100) : 0;
            const isExpanded = expandedProvider === group.provider;

            return (
              <Card key={group.provider} padding="sm" className="hover:border-border transition-colors">
                <div className="flex flex-col gap-2.5">
                  {/* Group Header & Sub-bar */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs text-text-main uppercase tracking-wider">
                        {group.provider}
                      </span>
                      <Badge variant="default" size="sm">
                        {total} models
                      </Badge>
                      {ok > 0 && (
                        <span className="text-[11px] font-mono font-semibold text-success flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-success" />
                          {ok} online
                        </span>
                      )}
                      {err > 0 && (
                        <span className="text-[11px] font-mono font-semibold text-error flex items-center gap-1">
                          <span className="h-2 w-2 rounded-full bg-error" />
                          {err} err
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {tested > 0 && (
                        <span className="font-mono text-[11px] text-text-muted">
                          {groupRatio}%
                        </span>
                      )}
                      <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => startBatch(group.models)}
                        disabled={running}
                      >
                        Check Group
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setExpandedProvider(isExpanded ? null : group.provider)
                        }
                      >
                        {isExpanded ? "Collapse" : "Table"}
                      </Button>
                    </div>
                  </div>

                  {/* Provider Upstream Progress Bar */}
                  <div className="h-1.5 w-full bg-surface-2 rounded-full overflow-hidden flex">
                    {ok > 0 && (
                      <div
                        className="h-full bg-success"
                        style={{ width: `${(ok / total) * 100}%` }}
                      />
                    )}
                    {err > 0 && (
                      <div
                        className="h-full bg-error"
                        style={{ width: `${(err / total) * 100}%` }}
                      />
                    )}
                    {untested > 0 && (
                      <div
                        className="h-full bg-border"
                        style={{ width: `${(untested / total) * 100}%` }}
                      />
                    )}
                  </div>

                  {/* GitHub Style Contribution Squares */}
                  <div className="flex flex-wrap gap-1.5 p-1.5 bg-surface-2/40 rounded-lg border border-border-subtle/50">
                    {group.models.map((m) => {
                      const res = probeResults[m.id];
                      const isChecking = res?.checking;
                      const isOk = res && res.ok;
                      const isErr = res && !res.ok && !isChecking;
                      // Timeout is a distinct outcome from a real error. A slow
                      // reasoning seat that missed the 30s window is not the
                      // same as a 404 or a revoked key, and painting both red
                      // makes the whole grid look broken during a busy sweep.
                      const isTimeout = isErr && typeof res.error === "string" && /timeout|aborted/i.test(res.error);
                      const isSelected = selectedModel?.id === m.id;

                      let bgClass = "bg-surface border-border hover:border-text-muted";
                      if (isChecking) bgClass = "bg-warning animate-pulse border-warning";
                      else if (isOk) bgClass = "bg-success border-success/70 hover:brightness-110 shadow-sm shadow-success/20";
                      else if (isTimeout) bgClass = "bg-warning/70 border-warning hover:brightness-110";
                      else if (isErr) bgClass = "bg-error border-error/70 hover:brightness-110";

                      return (
                        <button
                          key={m.id}
                          onClick={() => setSelectedModel(res || { id: m.id })}
                          title={`${m.id}\nStatus: ${isChecking ? "checking..." : isOk ? "200 OK (" + res.latencyMs + "ms)" : isTimeout ? "TIMEOUT — slow or busy (retry)" : isErr ? "ERROR: " + res.error : "untested"}`}
                          className={`h-4 w-4 rounded-sm border transition-all cursor-pointer ${bgClass} ${
                            isSelected ? "ring-2 ring-primary ring-offset-1 ring-offset-surface scale-125 z-10" : ""
                          }`}
                        />
                      );
                    })}
                  </div>

                  {/* Optional Expanded Detailed Table */}
                  {isExpanded && (
                    <div className="mt-2 overflow-x-auto border-t border-border-subtle pt-2">
                      <table className="w-full text-left text-xs font-mono">
                        <thead>
                          <tr className="text-text-muted text-[10px]">
                            <th className="py-1 px-2">Model</th>
                            <th className="py-1 px-2">Status</th>
                            <th className="py-1 px-2 text-right">Latency</th>
                            <th className="py-1 px-2">Details</th>
                            <th className="py-1 px-2 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.models.map((m) => {
                            const res = probeResults[m.id];
                            return (
                              <tr
                                key={m.id}
                                className="border-b border-border-subtle/30 last:border-0 hover:bg-surface-2"
                              >
                                <td className="py-1 px-2 truncate max-w-[200px]">{m.id}</td>
                                <td className="py-1 px-2">
                                  {res?.checking ? (
                                    <span className="text-warning">⟳ ping...</span>
                                  ) : res?.ok ? (
                                    <span className="text-success font-semibold">● OK</span>
                                  ) : res?.testedAt ? (
                                    <span className="text-error font-semibold">✕ {res.status || "ERR"}</span>
                                  ) : (
                                    <span className="text-text-muted">○ -</span>
                                  )}
                                </td>
                                <td className="py-1 px-2 text-right text-text-muted">
                                  {res?.latencyMs ? `${res.latencyMs}ms` : "—"}
                                </td>
                                <td className="py-1 px-2 text-[10px] text-error truncate max-w-[220px]">
                                  {res?.error || "—"}
                                </td>
                                <td className="py-1 px-2 text-right">
                                  <button
                                    onClick={() => pingOne(m)}
                                    disabled={running || res?.checking}
                                    className="text-primary hover:underline"
                                  >
                                    Ping
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
