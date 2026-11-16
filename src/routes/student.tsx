import { createFileRoute } from "@tanstack/react-router";
import { StudentPage } from "@/components/quiz/student";

export const Route = createFileRoute("/student")({
  head: () => ({ meta: [{ title: "Join a quiz · QuizNet" }] }),
  validateSearch: (search: Record<string, unknown>): { code?: string } => ({
    code: typeof search.code === "string" ? search.code : undefined,
  }),
  component: Student,
});

function Student() {
  const { code } = Route.useSearch();
  return <StudentPage initialCode={code} />;
}
