import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import EvolveClient from "./EvolveClient";

export const metadata = {
  title: "Payload Evolve — 9Router",
};

export default function PayloadEvolvePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <EvolveClient />
    </Suspense>
  );
}
