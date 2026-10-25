"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";

// Four views over the same question: which combination of model + payload
// actually lands. Presets are the inputs; sessions are the evidence; the
// leaderboard is the ranking; drift + tune are the maintenance layer that keeps
// the ranking from going stale.
const TABS = [
  { id: "presets", label: "Presets", icon: "bookmark" },
  { id: "sessions", label: "Sessions", icon: "history" },
  { id: "leaderboard", label: "Leaderboard", icon: "leaderboard" },
  { id: "drift", label: "Drift", icon: "trending_down" },
  { id: "tune", label: "Auto-Tune", icon: "auto_fix" },
];

function pct(n) {
  return `${Math.round((Number(n) || 0) * 100)}%`;
}

export default function JbToolsClient() {
  const [tab, setTab] = useState("presets");
  const [presets, setPresets] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [leaderboard, setLeaderboard] = useState({ models: [], bestPayloads: [] });
  const [drift, setDrift] = useState(null);
  const [tune, setTune] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Drift view state: pass current = local probe snapshot from the Model Status
  // kv scope so the page can diff and (optionally) save.
  const loadDrift = useCallback(async (save = false) => {
    setBusy(true);
    try {
      const snap = await fetch("/api/models/probe-matrix", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const current = {};
      (snap?.results || []).forEach((r) => { current[r.id] = { ok: !!r.ok, latencyMs: r.latencyMs || 0, error: r.error || null }; });
      const res = await fetch("/api/developer/jb-drift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, save }),
      });
      if (res.ok) setDrift(await res.json());
    } finally { setBusy(false); }
  }, []);

  const loadTune = useCallback(async (apply = false) => {
    setBusy(true);
    try {
      const res = apply
        ? await fetch("/api/developer/jb-tune", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ combo: "jb" }) })
        : await fetch("/api/developer/jb-tune?combo=jb", { cache: "no-store" });
      if (res.ok) setTune(await res.json());
    } finally { setBusy(false); }
  }, []);

  // New preset form
  const [form, setForm] = useState({
    name: "",
    model: "",
    payloadId: "",
    registerLevel: "standard",
    temperature: 0.7,
    maxTokens: 8000,
    topP: 1,
    notes: "",
  });

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [p, s, l] = await Promise.all([
        fetch("/api/developer/jb-presets", { cache: "no-store" }),
        fetch("/api/developer/jb-sessions?limit=100", { cache: "no-store" }),
        fetch("/api/developer/jb-leaderboard?limit=50", { cache: "no-store" }),
      ]);
      if (p.ok) setPresets(await p.json());
      if (s.ok) setSessions(await s.json());
      if (l.ok) setLeaderboard(await l.json());
      if (!p.ok && !s.ok && !l.ok) setError("All three endpoints failed — is the dashboard session valid?");
    } catch (err) {
      setError(err.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. The setState calls land inside await continuations, not in the
  // effect body, so the set-state-in-effect rule does not apply here.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await loadAll();
    })();
    return () => { cancelled = true; };
  }, [loadAll]);

  const savePreset = useCallback(async () => {
    if (!form.name.trim() || !form.model.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/developer/jb-presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setForm((f) => ({ ...f, name: "", payloadId: "", notes: "" }));
        await loadAll();
      }
    } finally {
      setBusy(false);
    }
  }, [form, loadAll]);

  const removePreset = useCallback(async (id) => {
    setBusy(true);
    try {
      await fetch(`/api/developer/jb-presets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadAll();
    } finally {
      setBusy(false);
    }
  }, [loadAll]);

  const applyPreset = useCallback((p) => {
    // Hand the combination to the Playground through the same storage the
    // Playground already reads on mount, instead of another fetch hop.
    try {
      localStorage.setItem("jb.activePreset", JSON.stringify(p));
    } catch {}
  }, []);

  const topScore = useMemo(() => {
    const rows = leaderboard.models || [];
    return rows.length ? Math.max(...rows.map((r) => Number(r.score) || 0)) : 0;
  }, [leaderboard]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">bolt</span>
            JB Tools
          </h1>
          <p className="text-xs text-text-muted">
            Simpan kombinasi yang tembus, rekam sesinya, dan ranking model dari bukti nyata.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={loadAll} disabled={busy || loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <Card className="border-error/40"><p className="text-xs text-error">{error}</p></Card>
      )}

      <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-lg border border-border-subtle text-xs w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded font-medium transition-colors ${
              tab === t.id ? "bg-surface text-primary shadow-sm font-semibold" : "text-text-muted hover:text-text-main"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? <CardSkeleton /> : (
        <>
          {tab === "presets" && (
            <div className="flex flex-col gap-3">
              <Card padding="sm" className="flex flex-col gap-2.5">
                <div className="text-[11px] uppercase tracking-wide text-text-muted">New preset</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="name (deepseek-max)"
                    className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs font-mono text-text-main"
                  />
                  <input
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="model (mg/deepseek-ai/...)"
                    className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs font-mono text-text-main"
                  />
                  <input
                    value={form.payloadId}
                    onChange={(e) => setForm({ ...form, payloadId: e.target.value })}
                    placeholder="payload id (f:syad:t106-...)"
                    className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs font-mono text-text-main"
                  />
                  <input
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                    placeholder="notes"
                    className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text-main"
                  />
                  <label className="flex items-center gap-2 text-xs text-text-muted">
                    maxTokens
                    <input
                      type="number"
                      value={form.maxTokens}
                      onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
                      className="w-24 rounded border border-border bg-surface-2 px-2 py-1 text-xs font-mono"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs text-text-muted">
                    temp
                    <input
                      type="number"
                      step="0.05"
                      value={form.temperature}
                      onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
                      className="w-24 rounded border border-border bg-surface-2 px-2 py-1 text-xs font-mono"
                    />
                  </label>
                </div>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" onClick={savePreset} disabled={busy || !form.name.trim() || !form.model.trim()}>
                    Save preset
                  </Button>
                </div>
              </Card>

              {presets.length === 0 ? (
                <Card padding="sm"><p className="text-xs text-text-muted">Belum ada preset. Simpan kombinasi pertama di form atas.</p></Card>
              ) : presets.map((p) => (
                <Card key={p.id} padding="sm" className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-xs">{p.name}</span>
                      <Badge variant="default" size="sm">{p.model}</Badge>
                      {p.payloadId && <Badge variant="default" size="sm">{p.payloadId}</Badge>}
                      {!p.isActive && <Badge variant="warning" size="sm">disabled</Badge>}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-text-muted">tok {p.maxTokens} · t {p.temperature}</span>
                      <Button variant="secondary" size="xs" onClick={() => applyPreset(p)}>Apply</Button>
                      <Button variant="ghost" size="xs" onClick={() => removePreset(p.id)} disabled={busy}>Delete</Button>
                    </div>
                  </div>
                  {p.notes && <p className="text-[11px] text-text-muted">{p.notes}</p>}
                </Card>
              ))}
            </div>
          )}

          {tab === "sessions" && (
            sessions.length === 0 ? (
              <Card padding="sm"><p className="text-xs text-text-muted">Belum ada sesi tersimpan. Sesi muncul saat chat di Playground menghasilkan verdict complied/partial.</p></Card>
            ) : (
              <Card padding="none">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px] text-left text-xs">
                    <thead className="border-b border-border-subtle text-text-muted bg-surface/50">
                      <tr>
                        <th className="px-3 py-2">Time</th>
                        <th className="px-3 py-2">Model</th>
                        <th className="px-3 py-2">Verdict</th>
                        <th className="px-3 py-2 text-right">Score</th>
                        <th className="px-3 py-2">Payload</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <tr key={s.id} className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40">
                          <td className="px-3 py-2 text-text-muted font-mono text-[11px]">{new Date(s.timestamp).toLocaleTimeString()}</td>
                          <td className="px-3 py-2 font-mono truncate max-w-[260px]">{s.model}</td>
                          <td className="px-3 py-2">
                            <Badge variant={s.verdict === "complied" ? "success" : s.verdict === "partial" ? "warning" : "error"} size="sm">{s.verdict}</Badge>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{s.score}</td>
                          <td className="px-3 py-2 font-mono text-[10px] text-text-muted truncate max-w-[200px]">{s.detail?.payloadId || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )
          )}

          {tab === "leaderboard" && (
            <div className="flex flex-col gap-3">
              <Card padding="none">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">Model leaderboard (breach rate from stored sessions)</div>
                {(leaderboard.models || []).length === 0 ? (
                  <p className="p-3 text-xs text-text-muted">Belum ada bukti. Ranking muncul setelah ada sesi tersimpan.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[600px] text-left text-xs">
                      <thead className="border-b border-border-subtle/60 text-text-muted">
                        <tr>
                          <th className="px-3 py-2">#</th>
                          <th className="px-3 py-2">Model</th>
                          <th className="px-3 py-2 text-right">Complied</th>
                          <th className="px-3 py-2 text-right">Partial</th>
                          <th className="px-3 py-2 text-right">Refused</th>
                          <th className="px-3 py-2 text-right">Breach</th>
                          <th className="px-3 py-2 text-right">Mean score</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.models.map((r, i) => (
                          <tr key={r.model} className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40">
                            <td className="px-3 py-2 text-text-muted font-mono">{i + 1}</td>
                            <td className="px-3 py-2 font-mono truncate max-w-[280px]">{r.model}</td>
                            <td className="px-3 py-2 text-right font-mono text-success">{r.complied}</td>
                            <td className="px-3 py-2 text-right font-mono text-warning">{r.partial}</td>
                            <td className="px-3 py-2 text-right font-mono text-error">{r.refused}</td>
                            <td className="px-3 py-2 text-right font-mono font-bold">{pct(r.breachRate)}</td>
                            <td className="px-3 py-2 text-right font-mono">{Math.round(r.meanScore)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <Card padding="none">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">Best payload per model (from benchmark runs, min 2 measured)</div>
                {(leaderboard.bestPayloads || []).length === 0 ? (
                  <p className="p-3 text-xs text-text-muted">Belum ada data benchmark. Jalanin Benchmark di Developer tab dulu.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[500px] text-left text-xs">
                      <thead className="border-b border-border-subtle/60 text-text-muted">
                        <tr>
                          <th className="px-3 py-2">Model</th>
                          <th className="px-3 py-2">Payload</th>
                          <th className="px-3 py-2 text-right">Attempts</th>
                          <th className="px-3 py-2 text-right">Mean</th>
                          <th className="px-3 py-2 text-right">Best</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.bestPayloads.map((r) => (
                          <tr key={`${r.model}-${r.payloadId}`} className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40">
                            <td className="px-3 py-2 font-mono truncate max-w-[240px]">{r.model}</td>
                            <td className="px-3 py-2 font-mono text-[11px] truncate max-w-[200px]">{r.payloadId}</td>
                            <td className="px-3 py-2 text-right font-mono">{r.attempts}</td>
                            <td className="px-3 py-2 text-right font-mono">{Math.round(r.meanScore)}</td>
                            <td className="px-3 py-2 text-right font-mono">{r.bestScore}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}
          {tab === "drift" && (
            <div className="flex flex-col gap-3">
              <Card padding="sm" className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-text-muted">Model Drift</div>
                    <p className="text-xs text-text-muted mt-0.5">Banding probe terakhir vs baseline. Regression dulu (yang butuh aksi).</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="xs" onClick={() => loadDrift(false)} disabled={busy}>Check</Button>
                    <Button variant="primary" size="xs" onClick={() => loadDrift(true)} disabled={busy}>Check + Save Baseline</Button>
                  </div>
                </div>
              </Card>

              {!drift ? (
                <Card padding="sm"><p className="text-xs text-text-muted">Klik Check untuk banding dengan baseline. Belum ada baseline? Klik Check + Save Baseline dulu.</p></Card>
              ) : (
                <Card padding="none">
                  <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-text-muted border-b border-border-subtle">
                    Compared: {drift.compared ?? 0} · Baseline: {drift.baselineSize ?? 0}
                    {drift.saved && <span className="ml-2 text-primary">(baseline updated)</span>}
                  </div>
                  {(drift.drift || []).length === 0 ? (
                    <p className="p-3 text-xs text-text-muted">Tidak ada drift. Semua model stabil dibanding baseline.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[600px] text-left text-xs">
                        <thead className="border-b border-border-subtle/60 text-text-muted">
                          <tr>
                            <th className="px-3 py-2">Model</th>
                            <th className="px-3 py-2">Verdict</th>
                            <th className="px-3 py-2">Reason</th>
                            <th className="px-3 py-2 text-right">Before</th>
                            <th className="px-3 py-2 text-right">Now</th>
                          </tr>
                        </thead>
                        <tbody>
                          {drift.drift.map((d) => (
                            <tr key={d.model} className="border-b border-border-subtle/40 last:border-0 hover:bg-surface-2/40">
                              <td className="px-3 py-2 font-mono truncate max-w-[260px]">{d.model}</td>
                              <td className="px-3 py-2">
                                <Badge
                                  variant={d.verdict === "regression" ? "error" : d.verdict === "slower" ? "warning" : "success"}
                                  size="sm"
                                >
                                  {d.verdict}
                                </Badge>
                              </td>
                              <td className="px-3 py-2 text-text-muted truncate max-w-[220px]">{d.reason}</td>
                              <td className="px-3 py-2 text-right font-mono">{d.previous?.ok ? `${d.previous.latencyMs}ms` : "fail"}</td>
                              <td className="px-3 py-2 text-right font-mono">{d.current?.ok ? `${d.current.latencyMs}ms` : "fail"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {tab === "tune" && (
            <div className="flex flex-col gap-3">
              <Card padding="sm" className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-text-muted">Combo Auto-Tune</div>
                    <p className="text-xs text-text-muted mt-0.5">Reorder seat combo sesuai health + latency terakhir. Yang jawab cepat ditaruh depan.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="xs" onClick={() => loadTune(false)} disabled={busy}>Preview</Button>
                    <Button variant="primary" size="xs" onClick={() => loadTune(true)} disabled={busy || !tune?.changed}>Apply Reorder</Button>
                  </div>
                </div>
              </Card>

              {!tune ? (
                <Card padding="sm"><p className="text-xs text-text-muted">Klik Preview buat lihat urutan usulan.</p></Card>
              ) : (
                <Card padding="sm" className="flex flex-col gap-3">
                  <div className="text-xs text-text-muted">
                    Combo: <span className="font-mono font-bold text-text-main">{tune.combo}</span>
                    {tune.changed ? <span className="ml-2 text-warning font-semibold">perubahan tersedia</span> : <span className="ml-2 text-success font-semibold">sudah optimal</span>}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="text-[11px] uppercase tracking-wide text-text-muted">Sekarang → Usulan</div>
                    {tune.seats?.map((seat, i) => {
                      const newIdx = (tune.proposedOrder || tune.order || []).indexOf(seat);
                      const moved = newIdx !== i;
                      return (
                        <div key={seat} className="flex items-center gap-3 text-xs font-mono">
                          <span className="text-text-muted w-4">{i + 1}.</span>
                          <span className="truncate max-w-[320px]">{seat}</span>
                          {moved && <span className={`text-[10px] ${newIdx < i ? "text-success" : "text-warning"}`}>→ {newIdx + 1}</span>}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
