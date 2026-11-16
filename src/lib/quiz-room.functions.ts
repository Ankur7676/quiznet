import { createServerFn } from "@tanstack/react-start";
import {
  answerRoom,
  closeRoom,
  createRoom,
  joinRoom,
  playerStatus,
  roomBoard,
  type Letter,
} from "@/lib/quiz-room.server";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readCreate(data: unknown) {
  const body = asRecord(data);
  if (!body || typeof body.title !== "string" || !Array.isArray(body.questions)) {
    throw new Error("Quiz details are missing.");
  }
  const questions = body.questions.map((item) => {
    const row = asRecord(item);
    const options = asRecord(row?.options);
    return {
      text: typeof row?.text === "string" ? row.text : "",
      answer: row?.answer as Letter,
      options: {
        A: typeof options?.A === "string" ? options.A : "",
        B: typeof options?.B === "string" ? options.B : "",
        C: typeof options?.C === "string" ? options.C : "",
        D: typeof options?.D === "string" ? options.D : "",
      },
    };
  });
  const seconds = typeof body.seconds === "number" ? body.seconds : undefined;
  return { title: body.title, seconds, questions };
}

export const createQuiz = createServerFn({ method: "POST" })
  .validator(readCreate)
  .handler(async ({ data }) => createRoom(data));

function readCode(data: unknown): string {
  const body = asRecord(data);
  const code = typeof body?.code === "string" ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (code.length < 4) throw new Error("Enter the four-character code.");
  return code;
}

export const getBoard = createServerFn({ method: "POST" })
  .validator(readCode)
  .handler(async ({ data }) => roomBoard(data));

function readClose(data: unknown): { code: string; adminKey: string } {
  const body = asRecord(data);
  const code = typeof body?.code === "string" ? body.code : "";
  const adminKey = typeof body?.adminKey === "string" ? body.adminKey : "";
  if (code.length < 4 || adminKey.length < 16) throw new Error("Missing admin session.");
  return { code, adminKey };
}

export const closeQuiz = createServerFn({ method: "POST" })
  .validator(readClose)
  .handler(async ({ data }) => closeRoom(data.code, data.adminKey));

function readJoin(data: unknown): { code: string; name: string } {
  const body = asRecord(data);
  if (!body || typeof body.name !== "string") throw new Error("Enter your name.");
  const code = typeof body.code === "string" ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
  if (code.length < 4) throw new Error("Enter the four-character code.");
  return { code, name: body.name };
}

export const joinQuiz = createServerFn({ method: "POST" })
  .validator(readJoin)
  .handler(async ({ data }) => joinRoom(data.code, data.name));

function readPlayer(data: unknown): { code: string; playerKey: string } {
  const body = asRecord(data);
  const code = typeof body?.code === "string" ? body.code : "";
  const playerKey = typeof body?.playerKey === "string" ? body.playerKey : "";
  if (code.length < 4 || playerKey.length < 16) throw new Error("Join again.");
  return { code, playerKey };
}

export const quizStatus = createServerFn({ method: "POST" })
  .validator(readPlayer)
  .handler(async ({ data }) => playerStatus(data.code, data.playerKey));

function readAnswer(data: unknown): { code: string; playerKey: string; questionId: number; choice: string } {
  const body = asRecord(data);
  const code = typeof body?.code === "string" ? body.code : "";
  const playerKey = typeof body?.playerKey === "string" ? body.playerKey : "";
  const questionId = body?.questionId;
  const choice = body?.choice;
  if (code.length < 4 || playerKey.length < 16) throw new Error("Join again.");
  if (typeof questionId !== "number" || typeof choice !== "string") throw new Error("Choose an answer.");
  return { code, playerKey, questionId, choice };
}

export const submitAnswer = createServerFn({ method: "POST" })
  .validator(readAnswer)
  .handler(async ({ data }) => answerRoom(data.code, data.playerKey, data.questionId, data.choice));
