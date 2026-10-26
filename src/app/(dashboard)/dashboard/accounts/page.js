import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";

export const metadata = {
  title: "Account Limits — 9Router",
};

// Renders the per-connection quota panel: one card per signed-in account with
// its current allowance bars (Antigravity 5h / weekly, Claude usage, etc).
// This is the ACCOUNT view; /dashboard/quota is the LOG view (which prefix is
// carrying traffic, which one ran dry). They answer different questions and
// both stay reachable.
export default function AccountsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ProviderLimits />
    </Suspense>
  );
}
