/**
 * cache.js — chrome.storage.local TTL wrapper
 * TTL is now dynamic — read from user settings in background.js and passed in.
 * Default fallback is 7 days if no TTL is provided.
 */

const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function getCached(key, ttlMs = DEFAULT_CACHE_TTL_MS) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      const entry = result[key];
      if (!entry) return resolve(null);
      if (Date.now() - entry.timestamp > ttlMs) {
        chrome.storage.local.remove(key);
        return resolve(null);
      }
      resolve(entry.data);
    });
  });
}

export async function setCached(key, data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(
      { [key]: { data, timestamp: Date.now() } },
      resolve
    );
  });
}
