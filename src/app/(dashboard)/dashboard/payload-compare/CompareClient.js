"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Badge, Button, CardSkeleton } from "@/shared/components";

// Side-by-side payload reader.
//
// The registry ships ~80 payloads from three collections. Picking between two
// of them meant opening files on disk, so "which should I run" was a guess.
//
// The diff is set-based, not a real LCS: a line is marked changed when its
// trimmed text does not appear in the other payload at all. That is honest
// about what it measures — "this line is unique to A" — and avoids pulling a
// diff library in for a reading aid.
function lineStats(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export default function CompareClient() {
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/developer/payload-benchmark", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        if (cancelled) return;
        const list = body.payloads || [];
        setCatalog(list);
        if (list.length >= 2) {
          setA(list[0].id);
          setB(list[1].id);
        }
        setCatalogError("");
      } catch (e) {
        if (!cancelled) setCatalogError(e?.message || "Failed to load payload catalog");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const compare = useCallback(async () => {
    if (!a || !b) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ a, b });
      const res = await fetch(`/api/developer/payload-benchmark/compare?${params}`, {
        cache: "no-store",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setError(e?.message || "Failed to compare payloads");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [a, b]);

  // Line sets for the uniqueness check. Recomputed only when the payloads land.
  const lineSets = useMemo(() => {
    if (!data?.a?.found || !data?.b?.found) return null;
    return {
      a: new Set(lineStats(data.a.text)),
      b: new Set(lineStats(data.b.text)),
    };
  }, [data]);

  const renderPane = (side) => {
    const payload = data?.[side];
    if (!payload) return null;
    if (!payload.found) {
      return (
        <Card className="border-error/40">
          <p className="text-xs text-error">Unknown payload id: {payload.id}</p>
        </Card>
      );
    }

    const other = side === "a" ? lineSets?.b : lineSets?.a;
    const lines = String(payload.text).split("\n");

    return (
      <Card padding="none">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
          <span className="font-mono text-xs font-semibold">{payload.id}</span>
          {payload.cat && <Badge size="sm">{payload.cat}</Badge>}
          <span className="text-[10px] text-text-muted">
            {payload.chars} chars · {payload.lines} lines
            {payload.estTokens ? ` · ≈${payload.estTokens} tok` : ""}
          </span>
        </div>
        <div className="max-h-[520px] overflow-auto p-2">
          <pre className="text-[11px] leading-relaxed">
            {lines.map((line, i) => {
              const trimmed = line.trim();
              const unique = trimmed.length > 0 && other && !other.has(trimmed);
              return (
                <div
                  key={i}
                  className={
                    unique
                      ? "bg-warning/10 text-text-main"
                      : "text-text-muted"
                  }
                >
                  <span className="mr-2 inline-block w-8 select-none text-right text-[9px] opacity-50">
                    {i + 1}
                  </span>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        </div>
        {payload.truncated && (
          <p className="border-t border-border-subtle px-3 py-1 text-[10px] text-warning">
            Truncated at {data.maxTextChars} chars.
          </p>
        )}
      </Card>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold">Payload Compare</h1>
        <p className="text-xs text-text-muted">
          Read two payloads side by side. Highlighted lines are unique to that side.
        </p>
      </div>

      {catalogError && <p className="text-xs text-error">{catalogError}</p>}
      {!catalog && !catalogError && <CardSkeleton />}

      {catalog && (
        <Card padding="sm">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase text-text-muted">Left</span>
              <select
                value={a}
                onChange={(e) => setA(e.target.value)}
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 font-mono text-xs"
              >
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase text-text-muted">Right</span>
              <select
                value={b}
                onChange={(e) => setB(e.target.value)}
                className="rounded-lg border border-border bg-surface-2 px-2 py-1 font-mono text-xs"
              >
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="primary"
              size="sm"
              onClick={compare}
              disabled={loading || !a || !b}
            >
              {loading ? "Loading…" : "Compare"}
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-error">{error}</p>}
        </Card>
      )}

      {data && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {renderPane("a")}
          {renderPane("b")}
        </div>
      )}
    </div>
  );
}
