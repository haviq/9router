// Verify the client-side pattern matcher mirrors the server one.
//
// ModelPromptsClient shows "matches N" while the operator types. That badge is
// only useful if it agrees with what the server will actually do at request
// time — a badge that says 3 while the resolver matches 0 is worse than no
// badge at all. This checks the two implementations against the same inputs.
//
// Written as a file rather than an inline -e because the pattern sources
// contain `!`, which bash history expansion eats inside double quotes.

import { compilePattern } from "../open-sse/payload/modelPrompts.js";

// Kept byte-for-byte in sync with compileClientPattern in ModelPromptsClient.js.
function compileClientPattern(pattern) {
  const raw = String(pattern || "").trim();
  if (!raw) return null;

  if (raw.length > 2 && raw.startsWith("/") && raw.lastIndexOf("/") > 0) {
    const end = raw.lastIndexOf("/");
    const body = raw.slice(1, end);
    const flags = raw.slice(end + 1).replace(/[^i]/g, "");
    if (body) {
      try {
        const re = new RegExp(body, flags);
        return (id) => re.test(id);
      } catch {
        // Fall through to substring, same as the server and the component.
      }
    }
  }

  const needle = raw.toLowerCase();
  return (id) => String(id).toLowerCase().includes(needle);
}

const MODELS = [
  "kl/deepseek-v4.1-flash",
  "mg/deepseek-ai/DeepSeek-V4-Pro",
  "cn/minimax-m3",
  "gpt-5-turbo",
  "qwen3.8-flash",
];

const PATTERNS = ["deepseek", "claude", "/^kl\\//", "/^qwen-/", "/[invalid/", "   ", "", "MINIMAX"];

let failures = 0;

for (const p of PATTERNS) {
  const server = compilePattern(p);
  const client = compileClientPattern(p);

  const sN = server ? MODELS.filter((m) => server(m)).length : null;
  const cN = client ? MODELS.filter((m) => client(m)).length : null;

  const agree = sN === cN;
  if (!agree) failures++;

  console.log(
    `${agree ? "OK      " : "MISMATCH"} ${JSON.stringify(p).padEnd(14)} server=${String(sN).padEnd(4)} client=${cN}`,
  );
}

console.log(failures ? `\n${failures} mismatch(es)` : "\nall agree");
process.exit(failures ? 1 : 0);
