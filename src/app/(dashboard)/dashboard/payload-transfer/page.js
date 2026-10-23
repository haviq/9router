import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import TransferClient from "./TransferClient";

export const metadata = {
  title: "Payload Transfer — 9Router",
};

export default function PayloadTransferPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <TransferClient />
    </Suspense>
  );
}
