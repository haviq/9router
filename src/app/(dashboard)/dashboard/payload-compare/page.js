import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import CompareClient from "./CompareClient";

export const metadata = {
  title: "Payload Compare — 9Router",
};

export default function PayloadComparePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <CompareClient />
    </Suspense>
  );
}
