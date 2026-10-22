"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Badge, Button } from "@/shared/components";

// Per-model system prompts: a rule list resolved by the upstream model id.
// First match wins — two prompts claiming the same model contradict each
// other, and a silent merge produces a system message neither author wrote.
// The matching rules live in open-sse/payload/modelPrompts.js; this page only
// edits and persists the list.

const MAX_RULES = 24;

const EMPTY_RULE = () => ({
  id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  pattern: "",
  prompt: "",
  enabled: true,
});

export default function ModelPromptsClient() {
  const [enabled, setEnabled] = useState(false);
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // Live routable models, same source the Developer picker uses: /v1/models
  // never advertises a model the operator cannot reach, so the dropdown
  // cannot offer a pattern that will never match anything.
  const [liveModels, setLiveModels] = useState([]);
  const [modelsError, setModelsError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        setEnabled(!!body.injectionModelPromptsEnabled);
        setRules(Array.isArray(body.injectionModelPromptRules) ? body.injectionModelPromptRules : []);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e?.message || "Failed to load settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(async (body) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setError("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(e?.message || "Save failed");
    }
  }, []);

  // Local state first so typing never waits on the network; the PATCH is
  // fire-and-forget exactly like every other settings write in this app.
  const commitRules = useCallback(
    (next) => {
      setRules(next);
      patch({ injectionModelPromptRules: next });
    },
    [patch]
  );

  const toggleEnabled = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    patch({ injectionModelPromptsEnabled: next });
  }, [enabled, patch]);

  const updateRule = useCallback(
    (index, changes) => {
      commitRules(rules.map((r, i) => (i === index ? { ...r, ...changes } : r)));
    },
    [rules, commitRules]
  );

  const addRule = useCallback(() => {
    if (rules.length >= MAX_RULES) return;
    commitRules([...rules, EMPTY_RULE()]);
  }, [rules, commitRules]);

  const removeRule = useCallback(
    (index) => {
      commitRules(rules.filter((_, i) => i !== index));
    },
    [rules, commitRules]
  );

  const activeCount = rules.filter((r) => r.enabled !== false && r.pattern && r.prompt?.trim()).length;

  if (loading) {
    return (
      <Card padding="sm">
        <p className="text-xs text-text-muted">Loading…</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold sm:text-xl">Model Prompts</h1>
          <p className="text-xs text-text-muted sm:text-sm">
            A system prompt per model family. First matching rule wins; no match appends nothing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-success">Saved</span>}
          <Button
            variant={enabled ? "primary" : "secondary"}
            size="sm"
            onClick={toggleEnabled}
          >
            {enabled ? "Enabled" : "Disabled"}
          </Button>
          <Button variant="secondary" size="sm" onClick={addRule} disabled={rules.length >= MAX_RULES}>
            + Add rule
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-error/40">
          <p className="text-xs text-error">{error}</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <Badge variant={enabled ? "success" : "default"} size="sm">
          {enabled ? "ON" : "OFF"}
        </Badge>
        <span>
          {rules.length} rule{rules.length === 1 ? "" : "s"} · {activeCount} active · max {MAX_RULES}
        </span>
      </div>

      {rules.length === 0 ? (
        <Card padding="sm">
          <p className="text-sm text-text-main mb-1">No rules yet</p>
          <p className="text-xs text-text-muted">
            Add a rule with a pattern like <code className="font-mono">claude</code>,{" "}
            <code className="font-mono">gpt-5</code>, or a regex like{" "}
            <code className="font-mono">/^qwen-/</code>. Pattern matches the upstream model id,
            case-insensitively. A regex is used when written between slashes.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule, index) => (
            <Card key={rule.id || index} padding="sm">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rule.enabled !== false}
                    onChange={(e) => updateRule(index, { enabled: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300 text-primary"
                    title="Enable this rule"
                  />
                  <input
                    value={rule.pattern || ""}
                    onChange={(e) => updateRule(index, { pattern: e.target.value })}
                    list={`live-models-${index}`}
                    placeholder="pattern — claude, gpt-5, /^qwen-/"
                    className="h-8 min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-2 font-mono text-xs text-text-main"
                  />
                  <datalist id={`live-models-${index}`}>
                    {liveModels.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) updateRule(index, { pattern: e.target.value });
                    }}
                    className="h-8 max-w-[220px] rounded-lg border border-border bg-surface-2 px-2 text-xs text-text-main"
                    title="Pick a live model — /v1/models only lists models you can actually reach"
                  >
                    <option value="">
                      {liveModels.length ? `Pick live model (${liveModels.length})` : "No live models"}
                    </option>
                    {liveModels.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                  {rule.pattern && !rule.prompt?.trim() && (
                    <Badge variant="warning" size="sm">
                      no prompt
                    </Badge>
                  )}
                  <button
                    onClick={() => removeRule(index)}
                    className="rounded px-2 py-1 text-xs font-semibold text-error transition-colors hover:bg-error/10"
                    title="Remove rule"
                  >
                    Remove
                  </button>
                </div>
                <textarea
                  value={rule.prompt || ""}
                  onChange={(e) => updateRule(index, { prompt: e.target.value })}
                  placeholder="System prompt appended when this rule matches"
                  rows={4}
                  className="w-full resize-y rounded-lg border border-border bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-main"
                />
              </div>
            </Card>
          ))}
        </div>
      )}

      <p className="text-[10px] text-text-muted">
        Rules are evaluated top to bottom. Put specific patterns above generic ones:
        a rule for gpt-5 belongs above a rule for gpt, otherwise the generic
        rule swallows every match below it.
      </p>
    </div>
  );
}
