import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import AdaptiveClient from "./AdaptiveClient";

export const metadata = {
  title: "Adaptive Escalation — 9Router",
};

export default function PayloadAdaptivePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <AdaptiveClient />
    </Suspense>
  );
}
