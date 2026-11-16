import { createServerFn } from "@tanstack/react-start";
import { connectDesk, labStatus, pullDesk, sendDesk, type BridgeSnap } from "@/lib/quiz-bridge.server";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

export const getLabStatus = createServerFn({ method: "GET" }).handler(async () => {
  return await labStatus();
});

function readUsername(data: unknown): string {
  if (typeof data !== "object" || data === null || !("username" in data)) {
    throw new Error("Username is required.");
  }
  const username = (data as { username: unknown }).username;
  if (typeof username !== "string") throw new Error("Username is required.");
  return username;
}

export const joinDesk = createServerFn({ method: "POST" })
  .validator(readUsername)
  .handler(async ({ data }): Promise<BridgeSnap> => {
    return connectDesk(data);
  });

function readPull(data: unknown): string {
  if (typeof data !== "object" || data === null || !("deskId" in data)) {
    throw new Error("Missing desk.");
  }
  const deskId = (data as { deskId: unknown }).deskId;
  if (typeof deskId !== "string" || deskId.length < 8) throw new Error("Missing desk.");
  return deskId;
}

export const pollDesk = createServerFn({ method: "POST" })
  .validator(readPull)
  .handler(async ({ data }): Promise<BridgeSnap> => {
    return pullDesk(data);
  });

function readSend(data: unknown): { deskId: string; message: JsonObject } {
  const body = asObject(data);
  if (!body || typeof body.deskId !== "string") throw new Error("Missing desk.");
  const message = asObject(body.message);
  if (!message) throw new Error("Missing message.");
  return { deskId: body.deskId, message };
}

export const talkDesk = createServerFn({ method: "POST" })
  .validator(readSend)
  .handler(async ({ data }): Promise<BridgeSnap> => {
    return sendDesk(data.deskId, data.message);
  });
