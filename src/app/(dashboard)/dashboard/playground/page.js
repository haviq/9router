import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import PlaygroundClient from "./PlaygroundClient";

export const metadata = {
  title: "Playground — 9Router",
};

export default function PlaygroundPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <PlaygroundClient />
    </Suspense>
  );
}
