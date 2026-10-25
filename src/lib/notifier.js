// Telegram notifier.
//
// One helper every subsystem calls. Unconfigured = silently disabled, so the
// feature is inert on a box that does not want it and there is no code path
// that half-sends. Delivery is fire-and-forget: an alert about an outage must
// never become an outage of its own by blocking the caller on a Telegram
// round trip.

const DEFAULT_TIMEOUT_MS = 6000;

let cachedConfig = null;
let cachedAt = 0;
const CONFIG_TTL_MS = 30_000;

// Read token + chat id from settings, cached briefly. Called on every notify,
// which happens on the alert path, so it must not read the DB per call during
// a burst of alerts.
async function readConfig() {
  const now = Date.now();
  if (cachedConfig && now - cachedAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("@/lib/localDb");
    const settings = await getSettings();
    cachedConfig = {
      token: settings?.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
      chatId: settings?.telegramChatId || process.env.TELEGRAM_CHAT_ID || "",
      enabled: settings?.telegramNotifyEnabled !== false,
    };
  } catch {
    cachedConfig = { token: "", chatId: "", enabled: false };
  }
  cachedAt = now;
  return cachedConfig;
}

export function invalidateNotifierConfig() {
  cachedConfig = null;
  cachedAt = 0;
}

async function post(token, chatId, text, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      signal: ctrl.signal,
    });
    return res.ok;
  } finally {
    clearTimeout(t);
  }
}

// Send an alert. Returns { sent, reason } and never throws.
//
// `level` is a plain string — the caller decides the semantics. On an
// unconfigured box this returns { sent: false, reason: "not-configured" } so a
// caller that wants telemetry can distinguish "operator turned it off" from
// "Telegram is down".
export async function notify({ title = "9router", message = "", level = "info", key = null } = {}) {
  try {
    const cfg = await readConfig();
    if (!cfg.enabled) return { sent: false, reason: "disabled" };
    if (!cfg.token || !cfg.chatId) return { sent: false, reason: "not-configured" };

    const emoji = level === "error" ? "❌" : level === "warning" ? "⚠️" : level === "success" ? "✅" : "ℹ️";
    const text = `${emoji} *${title}*\n${message}`;

    const ok = await post(cfg.token, cfg.chatId, text, DEFAULT_TIMEOUT_MS);
    return ok ? { sent: true } : { sent: false, reason: "http-error" };
  } catch (err) {
    return { sent: false, reason: err?.name === "AbortError" ? "timeout" : "exception" };
  }
}

// Deduplicate repeated alerts for the same event key.
//
// A provider that goes down at 12:00 stays down at 12:05. Without this the
// operator gets the same message sixty times an hour, mutes the bot, and stops
// seeing the alert that matters. One key = one notice per window.
const DEDUP_WINDOW_MS = 30 * 60 * 1000;
if (!globalThis._9rNotifyDedup) globalThis._9rNotifyDedup = new Map();
const seen = globalThis._9rNotifyDedup;

export function shouldNotify(key, now = Date.now()) {
  if (!key) return true;
  const last = seen.get(key);
  if (last && now - last < DEDUP_WINDOW_MS) return false;
  seen.set(key, now);
  return true;
}

export function resetNotifyDedup() {
  seen.clear();
}

export const NOTIFY_LIMITS = { DEFAULT_TIMEOUT_MS, CONFIG_TTL_MS, DEDUP_WINDOW_MS };
