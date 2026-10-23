import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import QuotaClient from "./QuotaClient";

export const metadata = {
  title: "Provider Quota — 9Router",
};

export default function QuotaPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <QuotaClient />
    </Suspense>
  );
}
