import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import EncodingClient from "./EncodingClient";

export const metadata = {
  title: "Encoding Ladder — 9Router",
};

export default function PayloadEncodingPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <EncodingClient />
    </Suspense>
  );
}
