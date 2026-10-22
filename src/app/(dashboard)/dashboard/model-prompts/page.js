import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ModelPromptsClient from "./ModelPromptsClient";

export const metadata = {
  title: "Model Prompts — 9Router",
};

export default function ModelPromptsPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <ModelPromptsClient />
    </Suspense>
  );
}
