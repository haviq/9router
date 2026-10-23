import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import MatrixClient from "./MatrixClient";

export const metadata = {
  title: "Model Matrix — 9Router",
};

export default function PayloadMatrixPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <MatrixClient />
    </Suspense>
  );
}
