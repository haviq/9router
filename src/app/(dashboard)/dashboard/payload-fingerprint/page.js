import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import FingerprintClient from "./FingerprintClient";

export const metadata = {
  title: "Guard Fingerprint — 9Router",
};

export default function PayloadFingerprintPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <FingerprintClient />
    </Suspense>
  );
}
