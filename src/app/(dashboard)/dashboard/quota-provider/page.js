import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import QuotaProviderClient from "./QuotaProviderClient";

export const metadata = {
  title: "Provider Load",
};

export default function Page() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <QuotaProviderClient />
    </Suspense>
  );
}
