import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ModelStatusClient from "./ModelStatusClient";

export const metadata = {
  title: "Model Status — 9Router",
};

export default function ModelStatusPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ModelStatusClient />
    </Suspense>
  );
}
