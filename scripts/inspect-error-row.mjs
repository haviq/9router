// Inspect the actual shape of a failed requestDetails row.
//
// Why: the quota route reads detail.providerResponse, but the one error row on
// this instance carries `{}` there — an empty object. If that is the normal
// shape, classifying quota from providerResponse can never work and the route
// would report "no quota" forever while the provider is plainly out of credit.
// Better to look at the real row than to assume the field is populated.

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/app/data/db/data.sqlite");

const total = db.prepare("SELECT COUNT(*) AS c FROM requestDetails").get().c;
console.log("total rows:", total);

const byStatus = db.prepare("SELECT status, COUNT(*) AS c FROM requestDetails GROUP BY status").all();
for (const r of byStatus) console.log(`  status=${r.status}  count=${r.c}`);

const rows = db
  .prepare("SELECT provider, model, status, data FROM requestDetails ORDER BY timestamp DESC LIMIT 40")
  .all();

console.log("\nsample of last", rows.length, "rows:");
for (const r of rows) {
  let d = null;
  try {
    d = JSON.parse(r.data);
  } catch {
    console.log(`  ${r.provider} ${r.status} — unparseable data`);
    continue;
  }

  const pr = d?.providerResponse;
  const prSize = pr == null ? "null" : JSON.stringify(pr).length;
  const respSize = d?.response == null ? "null" : JSON.stringify(d.response).length;

  console.log(
    `  ${String(r.provider).padEnd(26)} ${String(r.status).padEnd(10)} pr=${prSize}ch resp=${respSize}ch keys=${Object.keys(d).length}`,
  );

  // Show the first error row's body in full — that is the one that matters.
  if (r.status !== "success" && prSize !== "null" && prSize !== "2") {
    console.log("    providerResponse:", JSON.stringify(pr).slice(0, 400));
  }
}

db.close();
