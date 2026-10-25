import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import JbToolsClient from "./JbToolsClient";

export const metadata = {
  title: "JB Tools — 9Router",
};

export default function JbToolsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <JbToolsClient />
    </Suspense>
  );
}
