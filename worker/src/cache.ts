const CACHE_PREFIX = "cfmemos:v1:";

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getCachedJson<T>(cache: KVNamespace | undefined, key: string): Promise<T | null> {
  if (!cache) {
    return null;
  }

  try {
    return await cache.get<T>(CACHE_PREFIX + key, "json");
  } catch (error) {
    console.warn("KV cache read failed", error);
    return null;
  }
}

export async function putCachedJson(cache: KVNamespace | undefined, key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!cache) {
    return;
  }

  try {
    await cache.put(CACHE_PREFIX + key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  } catch (error) {
    console.warn("KV cache write failed", error);
  }
}

export async function deleteCachedKeys(cache: KVNamespace | undefined, keys: string[]): Promise<void> {
  if (!cache || keys.length === 0) {
    return;
  }

  await Promise.all(keys.map(async (key) => {
    try {
      await cache.delete(CACHE_PREFIX + key);
    } catch (error) {
      console.warn("KV cache delete failed", error);
    }
  }));
}
