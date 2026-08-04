/**
 * background.js — Service Worker (Chrome MV3)
 *
 * Handles all outbound network requests from the content script.
 * Reads cacheDurationDays from user settings to apply the correct TTL.
 *
 * Message protocol:
 *   Request:  { type: "GET_RATING", title: string, year: string|null, jwSlug: string|null, yearFromUrl: boolean }
 *   Response: { success: true, data: RatingResult } | { success: false, error: string }
 */

import { fetchLetterboxdRating } from "./letterboxd.js";
import { getCached, setCached } from "./cache.js";

const SETTINGS_KEY = "lbjw_settings";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_RATING") return false;

  handleGetRating(message.title, message.year, message.jwSlug, message.yearFromUrl)
    .then((data) => sendResponse({ success: true, data }))
    .catch((err) => sendResponse({ success: false, error: err.message }));

  return true; // keep message channel open for async response
});

/**
 * Reads the user's saved settings from storage.
 * Falls back to defaults if nothing is saved yet.
 */
async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      resolve(result[SETTINGS_KEY] ?? {});
    });
  });
}

/**
 * Fetches Letterboxd rating with user-controlled cache TTL.
 *
 * @param {string}      title
 * @param {string|null} year
 * @param {string|null} jwSlug       — JustWatch URL slug, e.g. "race-2007"
 * @param {boolean}     yearFromUrl  — true when year was extracted from the JW href
 */
async function handleGetRating(title, year, jwSlug, yearFromUrl) {
  if (!title || title.trim().length < 1) return null;

  // Read user setting — default to 7 days if not set
  const settings = await getSettings();
  const cacheDays = settings.cacheDurationDays ?? 7;
  const cacheTtlMs = cacheDays * 24 * 60 * 60 * 1000;

  // jwSlug (e.g. "race-2007") is inherently unique on JustWatch — use it as
  // the primary cache key so two different movies named "Race" never share an entry.
  const cacheKey = jwSlug
    ? `lb:jw:v1:slug:${jwSlug}`
    : `lb:jw:v1:${title.toLowerCase().trim()}:${year ?? ""}`;

  // Pass the user's chosen TTL into the cache check
  const cached = await getCached(cacheKey, cacheTtlMs);
  if (cached !== null) {
    console.log(`[LB-JW] Cache hit (${cacheDays}d TTL): "${jwSlug ?? title}"`);
    return cached;
  }

  console.log(`[LB-JW] Fetching: "${title}" (slug=${jwSlug}, year=${year}, strictYear=${yearFromUrl})`);
  const result = await fetchLetterboxdRating(title, year, jwSlug, yearFromUrl);

  await setCached(cacheKey, result);
  return result;
}
