"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";
import useLiveModels from "@/shared/hooks/useLiveModels";

const STATUS_COLOR = {
  ok: "success",
  error: "error",
  checking: "warning",
  untested: "default",
};

export default function ModelStatusClient() {
  const { models: liveModels, loading: modelsLoading, error: modelsError } = useLiveModels();
  const [probeResults, setProbeResults] = useState({});
  const [running, setRunning] = useState(false);
  const [filterStatus, setFilterStatus] = useState("all"); // all, ok, error, untested
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [search, setSearch] = useState("");
  const [concurrency, setConcurrency] = useState(4);
  const cancelRef = useRef(false);

  // Fetch initial cached status from backend
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/models/probe-matrix", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.results)) {
            const map = {};
            data.results.forEach((r) => {
              map[r.id] = r;
            });
            setProbeResults(map);
          }
        }
      } catch {}
    })();
  }, []);

  // Group providers
  const providers = useMemo(() => {
    const set = new Set();
    liveModels.forEach((m) => {
      const p = m.id.includes("/") ? m.id.split("/")[0] : "default";
      set.add(p);
    });
    return Array.from(set).sort();
  }, [liveModels]);

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
    } catch (err) {
      setProbeResults((prev) => ({
        ...prev,
        [id]: {
          id,
          ok: false,
          status: 500,
          latencyMs: 0,
          error: err.message,
          checking: false,
          testedAt: new Date().toISOString(),
        },
      }));
    }
  }, []);

  // Batch probe execution
  const startBatch = useCallback(async (targets) => {
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
  }, [running, concurrency, pingOne]);

  const stopBatch = useCallback(() => {
    cancelRef.current = true;
    setRunning(false);
  }, []);

  // Filtered list
  const filteredModels = useMemo(() => {
    return liveModels.filter((m) => {
      const id = m.id.toLowerCase();
      const p = m.id.includes("/") ? m.id.split("/")[0] : "default";

      if (selectedProvider !== "all" && p !== selectedProvider) return false;
      if (search && !id.includes(search.toLowerCase())) return false;

      const res = probeResults[m.id];
      if (filterStatus === "ok" && !res?.ok) return false;
      if (filterStatus === "error" && (!res || res.ok)) return false;
      if (filterStatus === "untested" && res) return false;

      return true;
    });
  }, [liveModels, selectedProvider, search, filterStatus, probeResults]);

  // Stats
  const stats = useMemo(() => {
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
    const percent = tested > 0 ? Math.round((ok / tested) * 100) : 0;
    return { total: liveModels.length, ok, error, untested, percent };
  }, [liveModels, probeResults]);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">speed</span>
            Realtime Model Upstream Status
          </h1>
          <p className="text-xs text-text-muted">
            Live probe ke upstream provider untuk mendeteksi model mati, kuota habis, atau error seketika.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="secondary" size="sm" onClick={stopBatch}>
              Stop Check
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={() => startBatch(filteredModels)}
              disabled={filteredModels.length === 0}
            >
              Check {filteredModels.length} Models
            </Button>
          )}
        </div>
      </div>

      {/* Stat Cards & Health Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card padding="sm" className="text-center">
          <span className="text-text-muted text-[10px] uppercase font-semibold">Total Models</span>
          <div className="text-xl font-bold">{stats.total}</div>
        </Card>
        <Card padding="sm" className="text-center">
          <span className="text-text-muted text-[10px] uppercase font-semibold">Online (OK)</span>
          <div className="text-xl font-bold text-success">{stats.ok}</div>
        </Card>
        <Card padding="sm" className="text-center">
          <span className="text-text-muted text-[10px] uppercase font-semibold">Dead / Error</span>
          <div className="text-xl font-bold text-error">{stats.error}</div>
        </Card>
        <Card padding="sm" className="text-center">
          <span className="text-text-muted text-[10px] uppercase font-semibold">Health Ratio</span>
          <div className="text-xl font-bold text-primary">{stats.percent}%</div>
        </Card>
      </div>

      {/* Health Bar */}
      {stats.total > 0 && (
        <div className="w-full bg-surface-2 rounded-full h-2.5 overflow-hidden flex border border-border-subtle">
          <div
            className="bg-success h-full transition-all duration-300"
            style={{ width: `${(stats.ok / stats.total) * 100}%` }}
            title={`Online: ${stats.ok}`}
          />
          <div
            className="bg-error h-full transition-all duration-300"
            style={{ width: `${(stats.error / stats.total) * 100}%` }}
            title={`Error: ${stats.error}`}
          />
        </div>
      )}

      {/* Controls Card */}
      <Card padding="sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search model ID..."
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 font-mono text-xs text-text-main outline-none"
            />
          </div>

          {/* Provider Filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text-muted font-semibold">Provider:</span>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-text-main outline-none"
            >
              <option value="all">All Providers ({providers.length})</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* Status Filter Tabs */}
          <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-border-subtle text-xs">
            {[
              { id: "all", label: "All" },
              { id: "ok", label: "OK (Green)" },
              { id: "error", label: "Error (Red)" },
              { id: "untested", label: "Untested" },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setFilterStatus(tab.id)}
                className={`px-2.5 py-1 rounded font-medium transition-colors ${
                  filterStatus === tab.id
                    ? "bg-surface text-primary shadow-sm font-semibold"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Concurrency Selector */}
          <div className="flex items-center gap-1.5 text-xs text-text-muted">
            <span>Parallel:</span>
            <select
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              disabled={running}
              className="rounded border border-border bg-surface px-1.5 py-1 text-xs"
            >
              <option value={2}>2</option>
              <option value={4}>4</option>
              <option value={8}>8</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Model List Table */}
      {modelsLoading ? (
        <CardSkeleton />
      ) : modelsError ? (
        <Card className="border-error/40">
          <p className="text-xs text-error">{modelsError}</p>
        </Card>
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead className="border-b border-border-subtle text-text-muted bg-surface/50">
                <tr>
                  <th className="px-3 py-2 font-semibold w-8">#</th>
                  <th className="px-3 py-2 font-semibold">Model ID</th>
                  <th className="px-3 py-2 font-semibold">Status Upstream</th>
                  <th className="px-3 py-2 font-semibold text-right">Latency</th>
                  <th className="px-3 py-2 font-semibold">Error Details</th>
                  <th className="px-3 py-2 font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-xs text-text-muted">
                      No models match the current filter.
                    </td>
                  </tr>
                ) : (
                  filteredModels.map((m, idx) => {
                    const res = probeResults[m.id];
                    const isChecking = res?.checking;
                    const isOk = res && res.ok;
                    const isErr = res && !res.ok && !isChecking;

                    return (
                      <tr
                        key={m.id}
                        className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40 transition-colors"
                      >
                        <td className="px-3 py-2 text-text-muted font-mono text-[11px]">
                          {idx + 1}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-mono font-medium text-text-main text-[12px]">
                            {m.id}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          {isChecking ? (
                            <Badge variant="warning" size="sm">
                              <span className="inline-block animate-spin mr-1">⟳</span> pinging...
                            </Badge>
                          ) : isOk ? (
                            <Badge variant="success" size="sm">
                              ● 200 OK
                            </Badge>
                          ) : isErr ? (
                            <Badge variant="error" size="sm">
                              ✕ {res.status || "ERR"}
                            </Badge>
                          ) : (
                            <Badge variant="default" size="sm">
                              ○ untested
                            </Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[11px] tabular-nums">
                          {res?.latencyMs ? (
                            <span className={res.latencyMs > 2000 ? "text-warning" : "text-success"}>
                              {res.latencyMs} ms
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2 max-w-[280px]">
                          {res?.error ? (
                            <span
                              className="font-mono text-[10px] text-error line-clamp-1 block cursor-pointer hover:line-clamp-none"
                              title={res.error}
                            >
                              {res.error}
                            </span>
                          ) : res?.note ? (
                            <span className="text-[10px] text-text-muted">{res.note}</span>
                          ) : (
                            <span className="text-text-muted">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={isChecking || running}
                            onClick={() => pingOne(m)}
                          >
                            Test
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
