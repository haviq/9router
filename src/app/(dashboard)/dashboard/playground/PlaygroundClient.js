"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Button } from "@/shared/components";
import useLiveModels from "@/shared/hooks/useLiveModels";

export default function PlaygroundClient() {
  const { models: hookModels } = useLiveModels();
  const [directModels, setDirectModels] = useState([]);
  
  // Parameters state
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful assistant.");
  const [temperature, setTemperature] = useState(1.0);
  const [maxTokens, setMaxTokens] = useState(4096);
  const [topP, setTopP] = useState(1.0);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [freqPenalty, setFreqPenalty] = useState(0);
  const [presPenalty, setPresPenalty] = useState(0);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputPrompt, setInputPrompt] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortCtrlRef = useRef(null);
  const chatEndRef = useRef(null);
  const dropdownRef = useRef(null);

  // Load 600+ active models directly from probe-matrix endpoint
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/models/probe-matrix", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.activeModels) && data.activeModels.length > 0) {
            setDirectModels(data.activeModels);
            return;
          }
        }
      } catch {}
    })();
  }, []);

  // Auto-fill active API key from system if available & fetch models with that key
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/keys", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          const active = data?.keys?.find((k) => k.isActive)?.key || data?.keys?.[0]?.key;
          if (active) {
            setApiKey(active);
            // Fetch /v1/models using this active key directly
            try {
              const v1Res = await fetch("/v1/models", {
                headers: { Authorization: `Bearer ${active}` },
                cache: "no-store",
              });
              if (v1Res.ok) {
                const v1Json = await v1Res.json();
                if (Array.isArray(v1Json?.data) && v1Json.data.length > 0) {
                  setDirectModels(v1Json.data);
                }
              }
            } catch {}
          }
        }
      } catch {}
    })();
  }, []);

  // Combined live models list
  const liveModels = directModels.length > 0 ? directModels : hookModels;

  // Set default model once models load
  useEffect(() => {
    if (!selectedModel && liveModels.length > 0) {
      const preferred = liveModels.find((m) => m.id.includes("deepseek") || m.id.includes("free")) || liveModels[0];
      setSelectedModel(preferred.id);
    }
  }, [liveModels, selectedModel]);

  // Filter models for dropdown search
  const filteredDropdownModels = useMemo(() => {
    if (!modelSearch) return liveModels.slice(0, 100);
    const q = modelSearch.toLowerCase();
    return liveModels.filter((m) => m.id.toLowerCase().includes(q)).slice(0, 100);
  }, [liveModels, modelSearch]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowModelDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Scroll to bottom on new message / token
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send message with streaming SSE
  const handleSend = useCallback(async () => {
    const text = inputPrompt.trim();
    if (!text || streaming) return;

    const newMessages = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInputPrompt("");
    setStreaming(true);

    const assistantIdx = newMessages.length;
    setMessages((prev) => [...prev, { role: "assistant", content: "", thinking: "" }]);

    abortCtrlRef.current = new AbortController();

    const fullPayloadMessages = [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...newMessages,
    ];

    try {
      const headers = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: selectedModel,
          messages: fullPayloadMessages,
          temperature: Number(temperature),
          max_tokens: Number(maxTokens),
          top_p: Number(topP),
          frequency_penalty: Number(freqPenalty),
          presence_penalty: Number(presPenalty),
          stream: true,
        }),
        signal: abortCtrlRef.current.signal,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        let parsedErr = errBody;
        try {
          const j = JSON.parse(errBody);
          parsedErr = j.error?.message || j.error || errBody;
        } catch {}
        setMessages((prev) => {
          const copy = [...prev];
          copy[assistantIdx] = {
            role: "assistant",
            content: `Error: HTTP ${res.status}: ${parsedErr}`,
            error: true,
          };
          return copy;
        });
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accContent = "";
      let accThinking = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta || {};
            if (delta.content) {
              accContent += delta.content;
            }
            if (delta.reasoning_content || delta.thinking || delta.reasoning) {
              accThinking += delta.reasoning_content || delta.thinking || delta.reasoning;
            }

            setMessages((prev) => {
              const copy = [...prev];
              copy[assistantIdx] = {
                role: "assistant",
                content: accContent,
                thinking: accThinking,
              };
              return copy;
            });
          } catch {}
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const copy = [...prev];
          copy[assistantIdx] = {
            role: "assistant",
            content: `Network exception: ${err.message}`,
            error: true,
          };
          return copy;
        });
      }
    } finally {
      setStreaming(false);
      abortCtrlRef.current = null;
    }
  }, [inputPrompt, streaming, messages, systemPrompt, apiKey, selectedModel, temperature, maxTokens, topP, freqPenalty, presPenalty]);

  const handleStop = useCallback(() => {
    if (abortCtrlRef.current) {
      abortCtrlRef.current.abort();
      setStreaming(false);
    }
  }, []);

  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-100px)] min-h-[600px]">
      {/* Left Parameters Panel */}
      <div className="w-full lg:w-[320px] flex-shrink-0 flex flex-col gap-3 overflow-y-auto pr-1">
        <Card padding="sm" className="flex flex-col gap-3 border-border bg-surface/50">
          {/* API Key */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-medium flex items-center gap-1">
                API key <span className="text-[10px] text-text-muted/70">ⓘ</span>
              </span>
            </div>
            <div className="relative flex items-center">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key (sk_...)"
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 pr-8 font-mono text-xs text-text-main outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 text-text-muted hover:text-text-main text-xs"
              >
                {showApiKey ? "🙈" : "👁"}
              </button>
            </div>
            <div className="text-[10px] text-text-muted">
              Active 9router key. <a href="/dashboard/endpoint" className="text-primary hover:underline">Create one</a>.
            </div>
          </div>

          <hr className="border-border-subtle/40" />

          {/* System Prompt */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-medium flex items-center gap-1">
                System prompt <span className="text-[10px] text-text-muted/70">ⓘ</span>
              </span>
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={4}
              placeholder="You are a helpful assistant."
              className="w-full resize-y rounded-lg border border-border bg-surface-2 p-2.5 font-mono text-xs text-text-main outline-none focus:border-primary"
            />
          </div>

          <hr className="border-border-subtle/40" />

          {/* Temperature */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted font-medium flex items-center gap-1">
                Temperature <span className="text-[10px] text-text-muted/70">ⓘ</span>
              </span>
              <input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => setTemperature(Math.max(0, Math.min(2, Number(e.target.value))))}
                className="w-14 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-right font-mono text-xs text-text-main"
              />
            </div>
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-surface-2 rounded-lg cursor-pointer"
            />
          </div>

          {/* Max Tokens */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted font-medium flex items-center gap-1">
                Max tokens <span className="text-[10px] text-text-muted/70">ⓘ</span>
              </span>
              <input
                type="number"
                step="256"
                min="1"
                max="65536"
                value={maxTokens}
                onChange={(e) => setMaxTokens(Math.max(1, Number(e.target.value)))}
                className="w-20 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-right font-mono text-xs text-text-main"
              />
            </div>
            <input
              type="range"
              min="256"
              max="32768"
              step="256"
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-surface-2 rounded-lg cursor-pointer"
            />
          </div>

          {/* Top P */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-text-muted font-medium flex items-center gap-1">
                Top P <span className="text-[10px] text-text-muted/70">ⓘ</span>
              </span>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={topP}
                onChange={(e) => setTopP(Math.max(0, Math.min(1, Number(e.target.value))))}
                className="w-14 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-right font-mono text-xs text-text-main"
              />
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={topP}
              onChange={(e) => setTopP(Number(e.target.value))}
              className="w-full accent-primary h-1.5 bg-surface-2 rounded-lg cursor-pointer"
            />
          </div>

          <hr className="border-border-subtle/40" />

          {/* Advanced Accordion */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center justify-between text-xs font-semibold text-text-muted hover:text-text-main uppercase tracking-wider"
            >
              <span>Advanced</span>
              <span className="text-[10px]">{showAdvanced ? "▲" : "▼"}</span>
            </button>

            {showAdvanced && (
              <div className="flex flex-col gap-2.5 pt-1 text-xs">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-text-muted">
                    <span>Frequency Penalty</span>
                    <span className="font-mono">{freqPenalty}</span>
                  </div>
                  <input
                    type="range"
                    min="-2"
                    max="2"
                    step="0.1"
                    value={freqPenalty}
                    onChange={(e) => setFreqPenalty(Number(e.target.value))}
                    className="accent-primary h-1 bg-surface-2 rounded"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-text-muted">
                    <span>Presence Penalty</span>
                    <span className="font-mono">{presPenalty}</span>
                  </div>
                  <input
                    type="range"
                    min="-2"
                    max="2"
                    step="0.1"
                    value={presPenalty}
                    onChange={(e) => setPresPenalty(Number(e.target.value))}
                    className="accent-primary h-1 bg-surface-2 rounded"
                  />
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Right Chat Playground Area */}
      <div className="flex-1 flex flex-col rounded-xl border border-border bg-surface/50 overflow-hidden shadow-sm">
        {/* Header with Model Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 border-b border-border bg-surface/90">
          {/* Model Selector Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              type="button"
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs font-mono font-semibold text-text-main hover:bg-surface transition-colors"
            >
              <span className="text-primary">🌐</span>
              <span className="truncate max-w-[240px]">{selectedModel || "Select Model..."}</span>
              <span className="text-[10px] text-text-muted">▼</span>
            </button>

            {showModelDropdown && (
              <div className="absolute left-0 top-full mt-1.5 w-80 max-h-96 z-50 rounded-lg border border-border bg-surface p-2 shadow-xl flex flex-col gap-2">
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder="Search 600+ models..."
                  autoFocus
                  className="w-full rounded border border-border bg-surface-2 px-2.5 py-1 text-xs font-mono text-text-main outline-none focus:border-primary"
                />
                <div className="overflow-y-auto max-h-72 flex flex-col gap-0.5">
                  {filteredDropdownModels.length === 0 ? (
                    <div className="p-3 text-center text-xs text-text-muted">No models found</div>
                  ) : (
                    filteredDropdownModels.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setSelectedModel(m.id);
                          setShowModelDropdown(false);
                          setModelSearch("");
                        }}
                        className={`text-left px-2 py-1.5 rounded text-xs font-mono truncate transition-colors ${
                          selectedModel === m.id
                            ? "bg-primary/20 text-primary font-semibold"
                            : "text-text-main hover:bg-surface-2"
                        }`}
                      >
                        {m.id}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Header Action Buttons */}
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <a
              href="/dashboard/model-status"
              className="hover:text-primary transition-colors flex items-center gap-1"
            >
              <span>Details ↗</span>
            </a>
            <span className="text-border">|</span>
            <button
              type="button"
              onClick={handleClear}
              disabled={messages.length === 0 || streaming}
              className="hover:text-error transition-colors flex items-center gap-1 disabled:opacity-40"
            >
              <span>🗑 Clear</span>
            </button>
          </div>
        </div>

        {/* Chat History Messages */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3.5">
          {messages.length === 0 ? (
            <div className="m-auto flex flex-col items-center justify-center gap-2.5 text-center p-6 max-w-md">
              <div className="text-3xl">🔑</div>
              <p className="text-xs text-text-muted leading-relaxed">
                Start chatting with <span className="font-mono font-semibold text-text-main">{selectedModel || "selected model"}</span>. Messages will stream live via 9router runtime.
              </p>
            </div>
          ) : (
            messages.map((msg, i) => {
              const isUser = msg.role === "user";
              return (
                <div
                  key={i}
                  className={`flex flex-col gap-1 max-w-[85%] ${
                    isUser ? "self-end items-end" : "self-start items-start"
                  }`}
                >
                  <span className="text-[10px] text-text-muted font-mono uppercase tracking-wider">
                    {isUser ? "You" : selectedModel || "Assistant"}
                  </span>
                  
                  {/* Thinking Block if reasoning model */}
                  {msg.thinking && (
                    <div className="w-full rounded-lg border border-border-subtle bg-surface-2/40 p-2.5 font-mono text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap mb-1">
                      <div className="text-[9px] uppercase font-bold text-primary mb-1">Thinking process</div>
                      {msg.thinking}
                    </div>
                  )}

                  <div
                    className={`rounded-xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap break-words ${
                      isUser
                        ? "bg-primary text-primary-contrast font-medium shadow-sm"
                        : msg.error
                        ? "bg-error/15 border border-error/30 text-error font-mono text-[11px]"
                        : "bg-surface-2 border border-border-subtle text-text-main shadow-sm"
                    }`}
                  >
                    {msg.content || (streaming && i === messages.length - 1 ? "▌" : "")}
                  </div>
                </div>
              );
            })
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Chat Input Bar */}
        <div className="p-3 border-t border-border bg-surface/80">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              rows={2}
              placeholder="Type your message (Enter to send, Shift+Enter for new line)..."
              disabled={streaming}
              className="flex-1 resize-none rounded-lg border border-border bg-surface-2 p-2.5 font-mono text-xs text-text-main outline-none focus:border-primary disabled:opacity-50"
            />
            {streaming ? (
              <Button variant="secondary" size="sm" onClick={handleStop}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                type="submit"
                disabled={!inputPrompt.trim() || !selectedModel}
              >
                Send
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
