import { createFileRoute } from "@tanstack/react-router";
import { AdminPage } from "@/components/quiz/admin";

export const Route = createFileRoute("/admin")({
  head: () => ({ meta: [{ title: "Admin · QuizNet" }] }),
  component: AdminPage,
});
