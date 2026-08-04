/**
 * content.js — Letterboxd Ratings for JustWatch
 *
 * Scans all visible JustWatch movie tiles and injects Letterboxd rating badges.
 * Tiles that scroll into view are handled by IntersectionObserver.
 * TV shows are filtered out via URL path (/tv-show/ vs /movie/).
 *
 * Disambiguation improvements over the Prime Video version:
 *  • jwSlug extracted from href (e.g. "race-2007") is passed to background
 *    for direct Letterboxd slug matching — no ambiguity for named films.
 *  • Year extracted from href slug (e.g. "-2007") is flagged as `yearFromUrl`
 *    so TMDB uses strict (exact) year filtering instead of ±1 tolerance.
 */

// ── Global guard: suppress "Extension context invalidated" errors ──────────
window.addEventListener("unhandledrejection", (event) => {
  const msg = event.reason?.message ?? String(event.reason ?? "");
  if (
    msg.includes("Extension context invalidated") ||
    msg.includes("Could not establish connection") ||
    msg.includes("receiving end does not exist")
  ) {
    event.preventDefault();
  }
}, { capture: true });

(async () => {
  const PROCESSED = "data-lbjw-done";
  const inFlight  = new Map();
  let dead = false;

  // ── Settings (minRating filter) ─────────────────────────────────────────────
  // Loaded once at startup; live-updated via chrome.storage.onChanged below.

  let minRating = 0; // 0 = show all

  function loadMinRating() {
    chrome.storage.local.get("lbjw_settings", (result) => {
      minRating = parseFloat(result?.lbjw_settings?.minRating ?? 0);
    });
  }

  // Show/hide all injected badges based on current minRating
  function applyRatingFilter() {
    document.querySelectorAll(".kym-badge[data-rating]").forEach((badge) => {
      const r = parseFloat(badge.dataset.rating ?? "0");
      badge.style.display = (minRating > 0 && r < minRating) ? "none" : "";
    });
  }

  // Live-update when user changes the filter in the popup
  chrome.storage.onChanged.addListener((changes) => {
    if (changes["lbjw_settings"]) {
      const newSettings = changes["lbjw_settings"].newValue ?? {};
      minRating = parseFloat(newSettings.minRating ?? 0);
      applyRatingFilter();
    }
  });

  loadMinRating();

  // ── Safe messaging ──────────────────────────────────────────────────────────

  async function msg(payload) {
    if (dead) return null;
    if (!chrome?.runtime?.id) { dead = true; return null; }
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch {
      dead = true;
      return null;
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  const fmt  = (n) => {
    if (!n || isNaN(n)) return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  };
  const fmtR = (r) => Number(r).toFixed(2);
  const esc  = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function starBar(rating) {
    let h = "";
    for (let i = 1; i <= 5; i++) {
      const f = Math.min(1, Math.max(0, rating - (i - 1)));
      const cls = f >= 0.75 ? "full" : f >= 0.25 ? "half" : "empty";
      h += `<span class="kym-star kym-star-${cls}">★</span>`;
    }
    return h;
  }

  // ── JustWatch-specific: extract data from href ──────────────────────────────

  /**
   * Extracts the JustWatch movie slug from an anchor href.
   * e.g. "/en/movie/race-2007" → "race-2007"
   *      "/en/movie/avatar-fire-and-ash" → "avatar-fire-and-ash"
   */
  function extractJwSlug(anchor) {
    const href = anchor.getAttribute("href") ?? "";
    const m = href.match(/\/movie\/([^/?#\s]+)/);
    return m ? m[1] : null;
  }

  /**
   * Extracts the release year embedded in the JustWatch slug.
   * JustWatch appends the year to disambiguate same-name films:
   *   "race-2007", "border-2018", "wanted-2009", etc.
   * Returns { year, yearFromUrl: true } or { year: null, yearFromUrl: false }.
   */
  function extractYearFromSlug(jwSlug) {
    if (!jwSlug) return { year: null, yearFromUrl: false };
    const m = jwSlug.match(/-(\d{4})$/);
    if (m) {
      const yr = parseInt(m[1], 10);
      if (yr >= 1900 && yr <= new Date().getFullYear() + 3) {
        return { year: String(yr), yearFromUrl: true };
      }
    }
    return { year: null, yearFromUrl: false };
  }

  /**
   * Converts a JustWatch slug to a human-readable title.
   * e.g. "spider-man-no-way-home" → "Spider-Man No Way Home"
   *      "race-2007"              → "Race"  (year stripped)
   */
  function slugToTitle(slug) {
    if (!slug) return null;
    // Strip trailing year
    const withoutYear = slug.replace(/-\d{4}$/, "");
    // Hyphens → spaces
    return withoutYear
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // ── Title extraction ────────────────────────────────────────────────────────

  function extractTitle(anchor) {
    // 1. img alt — most reliable on JustWatch (poster images always have alt)
    const img = anchor.querySelector("img[alt]");
    if (img?.alt && img.alt.trim().length > 1 && img.alt.trim().length < 200) {
      return img.alt.trim();
    }

    // 2. aria-label
    const aria = anchor.getAttribute("aria-label");
    if (aria && aria.trim().length > 1 && aria.trim().length < 200) {
      return aria.trim();
    }

    // 3. Heading elements inside the card
    for (const sel of ["h1", "h2", "h3", "h4"]) {
      const txt = anchor.querySelector(sel)?.textContent?.trim();
      if (txt && txt.length > 1 && txt.length < 200) return txt;
    }

    // 4. span/div text content (JustWatch sometimes puts title in a span)
    for (const sel of [".title", "[class*='title']", "span", "p"]) {
      const txt = anchor.querySelector(sel)?.textContent?.trim();
      if (txt && txt.length > 1 && txt.length < 120 && !txt.includes("\n")) {
        return txt;
      }
    }

    // 5. Derive from URL slug (always available, last resort)
    const jwSlug = extractJwSlug(anchor);
    return slugToTitle(jwSlug);
  }

  /**
   * Attempts to extract a year from surrounding tile content (NOT the URL).
   * Used as supplemental year when the slug doesn't contain one.
   */
  function extractYearFromContent(anchor) {
    // Check a few ancestor levels for a visible year
    let el = anchor.parentElement;
    for (let i = 0; i < 4 && el; i++) {
      if (el.textContent && el.textContent.length < 1000) {
        const m = el.textContent.match(/\b(19\d{2}|20[012]\d)\b/);
        if (m) return m[0];
      }
      el = el.parentElement;
    }
    return null;
  }

  // ── Card detection ──────────────────────────────────────────────────────────

  function findCards() {
    // Target ONLY movie links — /tv-show/ is explicitly excluded
    // JustWatch URLs: /en/movie/{slug}, /us/movie/{slug}, /in/movie/{slug}, etc.
    return [...document.querySelectorAll('a[href*="/movie/"]')].filter((a) => {
      if (a.hasAttribute(PROCESSED)) return false;

      const r = a.getBoundingClientRect();
      if (r.width < 50 || r.height < 70) return false; // skip tiny/invisible anchors

      const aspectRatio = r.width / r.height;
      if (aspectRatio > 2.5) return false; // skip wide banner-style elements

      // Must contain an image (poster tile) or be big enough to be a card
      const hasImage = !!a.querySelector("img");
      if (!hasImage && r.height < 120) return false;

      return true;
    });
  }

  // ── Overflow fix: JustWatch clips card containers ───────────────────────────

  function forceAncestorOverflow(el) {
    let node = el;
    for (let i = 0; i < 5 && node && node !== document.body; i++) {
      const rect = node.getBoundingClientRect();
      if (rect.width > window.innerWidth * 0.85) break; // don't touch full-width containers
      const cs = window.getComputedStyle(node);
      if (cs.overflow !== "visible") {
        node.style.setProperty("overflow", "visible", "important");
      }
      node = node.parentElement;
    }
  }

  // ── Badge injection ─────────────────────────────────────────────────────────

  function injectBadge(anchor, data) {
    anchor.querySelector(".kym-badge")?.remove();

    const pos = window.getComputedStyle(anchor).position;
    if (pos === "static") anchor.style.position = "relative";

    forceAncestorOverflow(anchor);

    const r    = data.rating;
    const tier = r >= 4 ? "green" : r >= 3 ? "orange" : r >= 2 ? "amber" : "red";

    const badge = document.createElement("div");
    badge.className = `kym-badge kym-badge-${tier}`;
    badge.textContent = fmtR(data.rating);
    // Store rating as data attribute so applyRatingFilter can reference it
    badge.dataset.rating = String(data.rating);
    // Apply current filter immediately
    if (minRating > 0 && data.rating < minRating) badge.style.display = "none";
    anchor.appendChild(badge);
  }

  function injectHoverCard(anchor, title, data) {
    const badge = anchor.querySelector(".kym-badge");
    if (!badge) return;

    const count = fmt(data.ratingCount);
    const year  = data.year ?? "";
    const r     = data.rating;
    const tier  = r >= 4 ? "green" : r >= 3 ? "orange" : r >= 2 ? "amber" : "red";

    const html = `
      <a class="kym-hc-inner" href="${esc(data.url)}" target="_blank" rel="noopener noreferrer">
        <div class="kym-hc-header">
          <span class="kym-hc-title">${esc(title)}</span>
          ${year ? `<span class="kym-hc-year">${esc(year)}</span>` : ""}
        </div>
        <div class="kym-hc-stats-row">
          <div class="kym-hc-stars">${starBar(data.rating)}</div>
          <span class="kym-hc-score kym-text-${tier}">${fmtR(data.rating)}</span>
          ${count ? `<span class="kym-hc-count">${count} ratings</span>` : ""}
        </div>
        <div class="kym-hc-footer">View on Letterboxd ↗</div>
      </a>
    `;

    badge._kymHoverHTML = html;
    badge.style.pointerEvents = "auto";
    badge.style.cursor = "pointer";

    badge.addEventListener("mouseenter", () => {
      document.querySelector(".kym-hover-card")?.remove();

      const hc = document.createElement("div");
      hc.className = "kym-hover-card kym-hover-card-visible";
      hc.innerHTML = badge._kymHoverHTML;
      document.body.appendChild(hc);

      // Position the hover card above the badge
      const rect = badge.getBoundingClientRect();
      hc.style.position = "fixed";
      hc.style.zIndex = "2147483647";

      // After appending, measure card width to prevent off-screen overflow
      const hcRect = hc.getBoundingClientRect();
      let left = rect.left;
      if (left + hcRect.width > window.innerWidth - 8) {
        left = window.innerWidth - hcRect.width - 8;
      }
      hc.style.left = `${Math.max(8, left)}px`;
      hc.style.bottom = `${window.innerHeight - rect.top + 8}px`;

      hc.addEventListener("mouseenter", () => { hc._hovering = true; });
      hc.addEventListener("mouseleave", () => {
        hc._hovering = false;
        setTimeout(() => { if (!hc._hovering) hc.remove(); }, 150);
      });
    });

    badge.addEventListener("mouseleave", () => {
      setTimeout(() => {
        const hc = document.querySelector(".kym-hover-card");
        if (hc && !hc._hovering) hc.remove();
      }, 250);
    });
  }

  // ── Processing pipeline ─────────────────────────────────────────────────────

  async function processCard(anchor) {
    if (anchor.hasAttribute(PROCESSED)) return;
    anchor.setAttribute(PROCESSED, "true");

    // ── Extract all data upfront from the JustWatch tile ──────────────────
    const jwSlug = extractJwSlug(anchor);
    if (!jwSlug) {
      anchor.setAttribute(PROCESSED, "no-slug");
      return;
    }

    const title = extractTitle(anchor);
    if (!title) {
      anchor.setAttribute(PROCESSED, "no-title");
      return;
    }

    // Year: prefer URL slug (e.g. "race-2007" → 2007, reliable)
    // Fall back to content text if slug has no year
    const { year: yearFromSlug, yearFromUrl } = extractYearFromSlug(jwSlug);
    const year = yearFromSlug ?? extractYearFromContent(anchor);

    // Use jwSlug as dedup key — multiple tiles for the same film will share
    // a request rather than each firing independently
    const dedupKey = jwSlug;

    if (inFlight.has(dedupKey)) {
      try {
        const data = await inFlight.get(dedupKey);
        if (data) {
          injectBadge(anchor, data);
          injectHoverCard(anchor, title, data);
        }
      } catch { /* ignore */ }
      return;
    }

    const promise = msg({
      type: "GET_RATING",
      title,
      year,
      jwSlug,
      yearFromUrl,
    })
      .then((res) => (res?.success ? res.data : null))
      .catch(() => null);

    inFlight.set(dedupKey, promise);
    const data = await promise;
    setTimeout(() => inFlight.delete(dedupKey), 30_000);

    if (data) {
      injectBadge(anchor, data);
      injectHoverCard(anchor, title, data);
    }
  }

  // ── Observers ───────────────────────────────────────────────────────────────

  // IntersectionObserver: fires when tiles scroll into view
  const intObs = new IntersectionObserver(
    (entries) => {
      entries
        .filter((e) => e.isIntersecting)
        .map((e) => e.target)
        .filter((el) => !el.hasAttribute(PROCESSED))
        .forEach((el) => processCard(el));
    },
    { rootMargin: "300px 0px", threshold: 0.05 }
  );

  function scan() {
    const cards = findCards();
    cards.forEach((c) => {
      const r = c.getBoundingClientRect();
      // Process immediately if near the viewport; otherwise observe
      if (r.top < window.innerHeight + 300 && r.bottom > -300) {
        processCard(c);
      } else {
        intObs.observe(c);
      }
    });
  }

  // MutationObserver: catches dynamically added tiles (infinite scroll, SPA navigation)
  let muTimer = null;
  new MutationObserver(() => {
    clearTimeout(muTimer);
    muTimer = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // Scroll fallback
  let scrollTimer = null;
  window.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(scan, 300);
  }, { passive: true });

  // Initial scans — JustWatch is a React SPA, give it time to render
  setTimeout(scan, 800);
  setTimeout(scan, 2000);
  setTimeout(scan, 4000);

  console.log("[LB-JW] Letterboxd Ratings for JustWatch loaded ✓");
})();
