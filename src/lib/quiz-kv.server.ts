/**
 * Tiny key/value layer under the quiz logic.
 *
 * - Local dev, tests, any long-running Node server: in-memory Map (process-wide).
 * - Netlify (serverless, no shared memory between requests): Netlify Blobs with
 *   strong consistency, so every function instance sees the same rooms.
 *
 * Each player lives under its own key and only that player's requests write it,
 * so concurrent students never overwrite each other.
 */

export type Kv = {
  get<T>(key: string): Promise<T | null>;
  /** Returns false (and writes nothing) when `onlyIfNew` is set and the key already exists. */
  set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
};

const STORE_NAME = "quiznet-rooms";
const MEMORY_KEY = Symbol.for("quiznet.kv.memory");

function memoryKv(): Kv {
  const g = globalThis as typeof globalThis & { [MEMORY_KEY]?: Map<string, string> };
  if (!g[MEMORY_KEY]) g[MEMORY_KEY] = new Map();
  const map = g[MEMORY_KEY];
  return {
    async get<T>(key: string) {
      const raw = map.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as T);
    },
    async set(key, value, opts) {
      if (opts?.onlyIfNew && map.has(key)) return false;
      map.set(key, JSON.stringify(value));
      return true;
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

async function blobsKv(): Promise<Kv> {
  const { getStore } = await import("@netlify/blobs");
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  return {
    async get<T>(key: string) {
      return (await store.get(key, { type: "json" })) as T | null;
    },
    async set(key, value, opts) {
      if (opts?.onlyIfNew) {
        const result = await store.setJSON(key, value, { onlyIfNew: true });
        return result.modified;
      }
      await store.setJSON(key, value);
      return true;
    },
    async delete(key) {
      await store.delete(key);
    },
    async list(prefix) {
      const { blobs } = await store.list({ prefix });
      return blobs.map((blob) => blob.key);
    },
  };
}

function onNetlify(): boolean {
  return Boolean(process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT);
}

let cached: Promise<Kv> | null = null;

export function kv(): Promise<Kv> {
  if (!cached) cached = onNetlify() ? blobsKv() : Promise.resolve(memoryKv());
  return cached;
}
