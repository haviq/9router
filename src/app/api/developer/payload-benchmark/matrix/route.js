import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseModelMatrix } from "open-sse/payload/syadagenticTemplates.js";

export const dynamic = "force-dynamic";

// The matrix lives at the top of the SYADAGENTIC collection file. Nothing read
// it before: a markdown table is not an injectable payload, so the loader
// skipped it — which dropped the single most useful thing in the collection,
// the record of which template was observed to work on which model family.
//
// Path candidates rather than one fixed path: the file sits in the repo during
// development, under DATA_DIR in a packaged install, and under /app inside the
// container image. Guessing one of those and failing silently is worse than
// trying the three that actually exist.
function candidatePaths() {
  const out = [];
  const dataDir = process.env.DATA_DIR || join(homedir(), ".9router");
  out.push(join(dataDir, "payloads", "SYADAGENTIC", "templates.md"));
  out.push(join(process.cwd(), "SYADAGENTIC", "templates.md"));
  out.push(join("/app", "SYADAGENTIC", "templates.md"));
  return out;
}

function readMatrixSource() {
  for (const p of candidatePaths()) {
    try {
      if (existsSync(p)) {
        return { path: p, text: readFileSync(p, "utf8") };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// GET /api/developer/payload-benchmark/matrix
//
// Parsed model matrix plus the raw markdown block. Rows carry a normalised
// status (open / conditional / unknown) instead of the emoji-laden cell, so a
// client does not have to regex an emoji to decide whether to trust a row.
export async function GET() {
  try {
    const source = readMatrixSource();
    if (!source) {
      return Response.json(
        {
          error: "SYADAGENTIC/templates.md not found",
          tried: candidatePaths(),
        },
        { status: 404 },
      );
    }

    const rows = parseModelMatrix(source.text);

    const byStatus = rows.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});

    return Response.json({
      source: source.path,
      count: rows.length,
      byStatus,
      rows,
    });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
