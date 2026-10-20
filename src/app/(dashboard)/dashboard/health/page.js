import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderHealth from "./ProviderHealth";

export const metadata = {
  title: "Provider Health — 9Router",
};

export default function HealthPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ProviderHealth />
    </Suspense>
  );
}
