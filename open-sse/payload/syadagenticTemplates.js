// SYADAGENTIC template collection.
//
// The upstream collection ships as ONE markdown file holding dozens of
// templates, each delimited by a `## T<n>. NAME` heading. The payload registry
// assumes one file equals one payload, so a straight read would register a
// single 31KB blob and lose the per-template identity the operator needs to
// benchmark or select them individually.
//
// This module splits the file into one payload per template. Pure text work:
// no filesystem, no clock — the caller reads the file and passes the text, so
// the split rules are testable.

export const SYAD_COLLECTION_PREFIX = "syad";

// `## T1. POLICY PUPPETRY` / `## T100. ACCESSIBILITY OVERRIDE` / `## T101. DEEPSEEK 破甲`
const HEADING = /^##\s+T(\d+)\.\s*(.+?)\s*$/gm;

// A template shorter than this is a stub (a heading with a pointer to an
// external file and no body), not something worth injecting.
export const MIN_TEMPLATE_CHARS = 120;

// Stable id from a template title: lowercase, non-alphanumerics collapsed to
// a single dash, trimmed. Keeps `f:syad:t100-accessibility-override` readable
// in the catalog instead of `f:syad:t100`.
export function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Split the collection into individual templates.
 *
 * @param {string} markdown  Full file contents.
 * @returns {Array<{id, code, title, text, chars, stub}>}
 */
export function splitSyadagenticTemplates(markdown) {
  const src = typeof markdown === "string" ? markdown : "";
  if (!src.trim()) return [];

  // Collect heading offsets first, then slice between them. Two passes rather
  // than one because a template body may itself contain `## ` lines (the
  // markdown payloads do), and only the `T<n>.` shape marks a real boundary.
  const marks = [];
  HEADING.lastIndex = 0;
  let m;
  while ((m = HEADING.exec(src)) !== null) {
    marks.push({ start: m.index, code: `T${m[1]}`, title: m[2].trim() });
  }

  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    const body = src.slice(cur.start, end).trim();
    const slug = slugifyTitle(cur.title);

    out.push({
      // Code is part of the id so a renumbered upstream file still yields a
      // stable handle for the template the operator picked.
      id: `${cur.code.toLowerCase()}-${slug || "template"}`,
      code: cur.code,
      title: cur.title,
      text: body,
      chars: body.length,
      stub: body.length < MIN_TEMPLATE_CHARS,
    });
  }

  return out;
}

// The model matrix at the top of the file is reference material, not an
// injectable template. Exposed separately so the catalog can show which
// template the collection recommends per model without registering it as a
// payload that would be sent verbatim.
export function extractModelMatrix(markdown) {
  const src = typeof markdown === "string" ? markdown : "";
  const start = src.indexOf("## MODEL MATRIX");
  if (start === -1) return "";
  const next = src.indexOf("\n## ", start + 3);
  return src.slice(start, next === -1 ? src.length : next).trim();
}

// Parse the matrix table into rows.
//
// The table is the most useful thing in the collection — it says which template
// has been observed to work on which model family — and it was being dropped
// entirely because a markdown table is not an injectable payload. Parsing it
// separately lets the dashboard show the guidance without ever sending it.
//
// Verified status is normalised into three states rather than kept as raw text:
// the raw column mixes "✅ OPEN", "⚠️ butuh plan" and prose, and a caller that
// has to regex an emoji is a caller that will get it wrong.
export function parseModelMatrix(markdown) {
  const block = extractModelMatrix(markdown);
  if (!block) return [];

  const rows = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    // Skip the header row and the |---|---| separator.
    if (/^\|\s*-{2,}/.test(trimmed)) continue;

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length < 2) continue;
    const [model, bestTemplate, verifiedRaw = ""] = cells;
    if (/^model$/i.test(model)) continue;
    if (!model) continue;

    const verified = verifiedRaw || "";
    let status = "unknown";
    if (/✅|\bOPEN\b/i.test(verified)) status = "open";
    else if (/⚠️|\bbutuh\b|\bneeds?\b/i.test(verified)) status = "conditional";

    rows.push({
      model,
      bestTemplate,
      verified,
      status,
    });
  }

  return rows;
}
