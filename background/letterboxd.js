/**
 * letterboxd.js — Fetch and parse Letterboxd film rating
 *
 * Disambiguation strategy (in order of reliability):
 *
 * 0. JustWatch slug → Letterboxd slug direct mapping
 *    JustWatch slugs (e.g. "race-2007") often match Letterboxd slugs exactly.
 *    When JW appends a year to the slug, this is perfectly unambiguous.
 *
 * 1. TMDB ID → letterboxd.com/tmdb/{id}
 *    Bulletproof: Letterboxd redirects to the exact film page.
 *    Uses strict year matching when year was extracted from the JW URL.
 *
 * 2. Base slug fallback
 *    Try letterboxd.com/film/{slug}/ directly.
 *
 * 3. Letterboxd search
 *    Last resort — fetch /search/films/{query}/ and parse the top result.
 */

/**
 * Converts a movie title into a Letterboxd URL slug.
 * @param {string} title
 * @returns {string}
 */
export function titleToSlug(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Queries TMDB for the best-matching movie entry.
 * When `strictYear` is true (year came from the JW URL, highly reliable),
 * we require an exact year match to prevent wrong-film disambiguation.
 *
 * @param {string} title
 * @param {string|null} year
 * @param {boolean} strictYear  — exact year match (no ±1 tolerance)
 * @returns {Promise<{isTv: boolean, tmdbId: number|null}>}
 */
async function getTmdbInfo(title, year, strictYear = false) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/search/multi?api_key=15d2ea6d0dc1d476efbca3eba2b9bbfb&query=${encodeURIComponent(title)}`
    );
    if (res.status === 429) {
      console.warn(`[LB-JW] TMDB rate-limited for "${title}" — aborting to avoid wrong rating`);
      return { isTv: false, tmdbId: null };
    }

    const data = await res.json();
    if (!data.results?.length) return { isTv: false, tmdbId: null };

    // ── Find exact title matches ──────────────────────────────────────────
    let exact = data.results.filter(
      (m) => (m.title || m.name)?.toLowerCase() === title.toLowerCase()
    );

    // Sort by vote_count descending (more stable than popularity)
    exact.sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));

    // ── Year filtering ────────────────────────────────────────────────────
    if (year && exact.length > 1) {
      const target = parseInt(year, 10);
      // strictYear = came from JW URL slug, e.g. "race-2007" → 100% reliable → exact match
      // otherwise  = came from page text → allow ±1 year tolerance
      const tolerance = strictYear ? 0 : 1;

      const byYear = exact.filter((m) => {
        const dateStr = m.release_date || m.first_air_date || "";
        if (!dateStr) return false;
        return Math.abs(parseInt(dateStr.slice(0, 4), 10) - target) <= tolerance;
      });
      if (byYear.length > 0) exact = byYear;
    }

    // ── Pick best match ───────────────────────────────────────────────────
    let best;
    if (exact.length > 0) {
      const topTv    = exact.find((m) => m.media_type === "tv");
      const topMovie = exact.find((m) => m.media_type === "movie");

      if (topTv && topMovie) {
        // JustWatch is browsed for movies. Prefer movie unless TV is overwhelmingly popular.
        if (topMovie.vote_count > 300) {
          best = topMovie;
        } else if (topTv.popularity > topMovie.popularity * 5 || topTv.vote_count > topMovie.vote_count * 5) {
          best = topTv;
        } else {
          best = topMovie;
        }
      } else {
        best = exact[0];
      }
    } else {
      // No exact name match — use top TMDB result
      best = data.results[0];
    }

    return { isTv: best.media_type === "tv", tmdbId: best.id };
  } catch (err) {
    console.warn("[LB-JW] TMDB lookup failed:", err.message);
    return { isTv: false, tmdbId: null };
  }
}

/**
 * Main entry point.
 *
 * @param {string}      title
 * @param {string|null} year         — release year (may be null)
 * @param {string|null} jwSlug       — JustWatch URL slug (e.g. "race-2007")
 * @param {boolean}     yearFromUrl  — true when year was parsed from the JW href (very reliable)
 * @returns {Promise<object|null>}
 */
export async function fetchLetterboxdRating(title, year = null, jwSlug = null, yearFromUrl = false) {

  // ── Strategy 0: JW slug with embedded year → Letterboxd slug (ONLY when unambiguous) ──
  //
  // CRITICAL RULE: Only use this path when yearFromUrl=true, meaning the JW slug
  // itself contains the year (e.g. "race-2007", "titanic-2023"). This guarantees
  // there is exactly one film with that name+year combination on Letterboxd.
  //
  // We intentionally SKIP slugs without a year ("iron-man", "titanic", "avatar")
  // because Letterboxd maps those to the OLDEST film with that name by default:
  //   letterboxd.com/film/iron-man/  → Iron Man (1951)  ← WRONG
  //   letterboxd.com/film/titanic/   → Titanic (1943)   ← WRONG
  // For those cases, TMDB (Strategy 1) correctly finds the most popular/famous film.
  if (jwSlug && yearFromUrl) {
    // The slug has a year in it → try it directly on Letterboxd (unambiguous)
    try {
      const result = await fetchAndParse(`https://letterboxd.com/film/${jwSlug}/`, jwSlug);
      if (result) {
        console.log(`[LB-JW] ✓ Unambiguous JW slug hit (year in slug): "${jwSlug}"`);
        return result;
      }
    } catch {
      // 404 — Letterboxd uses a different slug for this film, fall through to TMDB
    }

    // Also try stripping the year from the slug (e.g. "race-2007" → "race")
    // but only accept the result if its year matches ours exactly (strict, since yearFromUrl=true)
    const slugWithoutYear = jwSlug.replace(/-\d{4}$/, "");
    try {
      const result = await fetchAndParse(`https://letterboxd.com/film/${slugWithoutYear}/`, slugWithoutYear);
      if (result && result.year && year) {
        if (Math.abs(parseInt(result.year, 10) - parseInt(year, 10)) <= 1) {
          console.log(`[LB-JW] ✓ Slug-stripped year verified: "${slugWithoutYear}" → ${result.year}`);
          return result;
        }
        console.log(`[LB-JW] Slug-stripped year mismatch: "${slugWithoutYear}" got ${result.year}, expected ${year} — skipping`);
      }
    } catch { /* fall through */ }
  }

  // ── Strategy 1: TMDB ID → letterboxd.com/tmdb/{id} ──────────────────────────
  // Pass strictYear=true when year came from the URL — gives exact TMDB match for
  // ambiguous titles like "Race", "Border", "Wanted", etc.
  const tmdbInfo = await getTmdbInfo(title, year, yearFromUrl);

  if (tmdbInfo.isTv) {
    console.log(`[LB-JW] Skipped "${title}" — TMDB identifies as TV`);
    return null;
  }

  if (tmdbInfo.tmdbId) {
    try {
      const result = await fetchAndParse(
        `https://letterboxd.com/tmdb/${tmdbInfo.tmdbId}`,
        null
      );
      if (result) {
        console.log(`[LB-JW] ✓ TMDB ID hit: "${title}" → tmdb/${tmdbInfo.tmdbId}`);
        return result;
      }
    } catch {
      console.warn(`[LB-JW] TMDB ID fetch failed for "${title}"`);
    }
  }

  // ── Strategy 2: Base slug (year-verified only) ──────────────────────────────
  // We ONLY accept the base slug result if a year is available AND it matches.
  //
  // Why: Letterboxd maps bare slugs ("iron-man", "titanic") to the OLDEST film
  // with that name, not the most famous one. Without year verification we'd return:
  //   iron-man → Iron Man (1951) ✗   |   titanic → Titanic (1943) ✗
  //
  // When no year is available, we skip to Strategy 3 (Letterboxd search) which
  // ranks results by popularity — correctly returning Iron Man (2008), Titanic (1997).
  const baseSlug = titleToSlug(title);
  if (year) {
    try {
      const result = await fetchAndParse(`https://letterboxd.com/film/${baseSlug}/`, baseSlug);
      if (result && result.year) {
        const diff = Math.abs(parseInt(result.year, 10) - parseInt(year, 10));
        if (diff <= 1) {
          console.log(`[LB-JW] ✓ Base slug hit (year verified): "${baseSlug}" → ${result.year}`);
          return result;
        }
        console.log(`[LB-JW] Base slug year mismatch: "${baseSlug}" got ${result.year}, expected ${year} — skipping to search`);
      }
    } catch {
      // fall through to search
    }
  } else {
    console.log(`[LB-JW] No year available for "${title}" — skipping base slug, using search for popularity ranking`);
  }

  // ── Strategy 3: Letterboxd search ────────────────────────────────────────────
  console.log(`[LB-JW] All direct strategies failed for "${title}" — trying search`);
  return await searchLetterboxd(title, year, yearFromUrl);
}

/**
 * Searches Letterboxd and returns the top result.
 * If year is available (especially from URL), filters results by year.
 */
async function searchLetterboxd(title, year, strictYear) {
  const query = encodeURIComponent(title);
  const searchUrl = `https://letterboxd.com/search/films/${query}/`;

  const response = await fetch(searchUrl, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    credentials: "omit",
  });

  if (!response.ok) {
    console.warn(`[LB-JW] Search HTTP ${response.status} for "${title}"`);
    return null;
  }

  const html = await response.text();

  // Extract all film slugs from search results
  const slugPattern = /href="\/film\/([a-z0-9][a-z0-9-]+[a-z0-9])\//g;
  const slugs = [];
  let m;
  while ((m = slugPattern.exec(html)) !== null) {
    if (!slugs.includes(m[1])) slugs.push(m[1]);
    if (slugs.length >= 5) break; // check top 5 results
  }

  if (!slugs.length) {
    console.warn(`[LB-JW] Search found no slugs for "${title}"`);
    return null;
  }

  // If year is available, try each candidate and pick the one whose year matches
  if (year) {
    const target = parseInt(year, 10);
    const tolerance = strictYear ? 0 : 1;

    for (const slug of slugs) {
      try {
        const result = await fetchAndParse(`https://letterboxd.com/film/${slug}/`, slug);
        if (result?.year && Math.abs(parseInt(result.year, 10) - target) <= tolerance) {
          console.log(`[LB-JW] ✓ Search year-verified: "${slug}" (${result.year})`);
          return result;
        }
      } catch { /* try next */ }
    }
    // If no year-matched result found, return the first valid result rather than nothing
    console.log(`[LB-JW] No year-matched search result for "${title}" — using top result`);
  }

  // No year or year-matching failed — use the top slug
  const topSlug = slugs[0];
  try {
    const result = await fetchAndParse(`https://letterboxd.com/film/${topSlug}/`, topSlug);
    if (result) {
      console.log(`[LB-JW] ✓ Search top result: "${topSlug}"`);
      return result;
    }
  } catch { /* nothing */ }

  console.warn(`[LB-JW] Search exhausted for "${title}"`);
  return null;
}

/**
 * Fetches a Letterboxd film page and parses rating data.
 * Follows redirects (important for /tmdb/{id} URLs).
 */
async function fetchAndParse(url, slugFallback) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Cache-Control": "no-cache",
    },
    credentials: "omit",
    redirect: "follow",
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`HTTP ${response.status}`);
  }

  const finalUrl = response.url;
  let finalSlug = slugFallback;
  const slugMatch = finalUrl.match(/\/film\/([^/?#]+)/);
  if (slugMatch) finalSlug = slugMatch[1];

  const html = await response.text();
  return parseLetterboxdHTML(html, finalSlug, finalUrl);
}

/**
 * Parses Letterboxd HTML for rating data.
 * Tries JSON-LD → twitter meta → data attribute in order.
 */
function parseLetterboxdHTML(html, slug, url) {
  // ── Strategy 1: JSON-LD structured data ──────────────────────────────────
  const jsonLdMatches = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );

  for (const match of jsonLdMatches) {
    try {
      let jsonStr = match[1].trim();
      if (jsonStr.startsWith("/* <![CDATA[ */")) {
        jsonStr = jsonStr.slice("/* <![CDATA[ */".length);
      }
      if (jsonStr.endsWith("/* ]]> */")) {
        jsonStr = jsonStr.slice(0, -"/* ]]> */".length);
      }

      const json = JSON.parse(jsonStr.trim());
      const entries = Array.isArray(json) ? json : [json];

      for (const entry of entries) {
        if (entry.aggregateRating) {
          const rating      = parseFloat(entry.aggregateRating.ratingValue);
          const ratingCount = parseInt(entry.aggregateRating.ratingCount, 10);
          const year        = extractYear(html);
          if (!isNaN(rating)) {
            return {
              rating: Math.round(rating * 100) / 100,
              ratingCount: isNaN(ratingCount) ? null : ratingCount,
              year,
              slug,
              url,
            };
          }
        }
      }
    } catch { /* malformed JSON-LD */ }
  }

  // ── Strategy 2: Twitter meta tag ─────────────────────────────────────────
  const metaMatch = html.match(
    /<meta[^>]+name=["']twitter:data2["'][^>]+content=["']([\d.]+)\s+out\s+of\s+\d["']/i
  );
  if (metaMatch) {
    const rating = parseFloat(metaMatch[1]);
    if (!isNaN(rating)) return { rating, ratingCount: null, year: extractYear(html), slug, url };
  }

  // ── Strategy 3: data-average-rating attribute ─────────────────────────────
  const dataAttrMatch = html.match(/data-average-rating=["']([\d.]+)["']/i);
  if (dataAttrMatch) {
    const rating = parseFloat(dataAttrMatch[1]);
    if (!isNaN(rating)) return { rating, ratingCount: null, year: extractYear(html), slug, url };
  }

  return null;
}

/**
 * Extracts release year from Letterboxd HTML.
 */
function extractYear(html) {
  const yearMatch = html.match(/class=["']releaseyear["'][^>]*>[\s\S]*?(\d{4})/i);
  if (yearMatch) return yearMatch[1];

  const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["'][^"']*\((\d{4})\)["']/i);
  if (ogMatch) return ogMatch[1];

  return null;
}
