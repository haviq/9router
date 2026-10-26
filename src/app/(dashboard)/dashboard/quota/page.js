import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";

export const metadata = {
  title: "Quota Tracker — 9Router",
};

// Per-account quota bars: one card per signed-in account with its live
// allowance (Antigravity 5h / weekly, Claude usage, Codex credits, ...).
// This is the page the operator means by "Quota Tracker" — a bar per account
// answering "how much is left on THIS account".
//
// The per-provider rollup (which prefix is carrying traffic, which one ran
// dry) lives on /dashboard/quota-provider and answers a different question.
// Rendering that here instead left the account bars unreachable from the UI.
export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ProviderLimits />
    </Suspense>
  );
}
