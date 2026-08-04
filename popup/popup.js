/**
 * popup.js — Extension popup logic for Letterboxd Ratings for JustWatch
 */

const SETTINGS_KEY = "lbjw_settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  showBadge: true,
  showHoverCard: true,
  cacheDurationDays: 7,
  minRating: 0,           // 0 = show all, otherwise hide badges below this score
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const statusDot     = document.getElementById("status-dot");
const statusText    = document.getElementById("status-text");
const statCached    = document.getElementById("stat-cached");
const statToday     = document.getElementById("stat-today");
const toggleEnabled  = document.getElementById("toggle-enabled");
const toggleBadge    = document.getElementById("toggle-badge");
const toggleHover    = document.getElementById("toggle-hover");
const clearBtn       = document.getElementById("clear-cache-btn");
const chipGroup      = document.getElementById("cache-duration-group");
const ratingSlider   = document.getElementById("rating-slider");
const ratingValue    = document.getElementById("rating-value");

// ── Settings ──────────────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result[SETTINGS_KEY] ?? {}) });
    });
  });
}

async function saveSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings }, resolve);
  });
}

// ── Cache stats ───────────────────────────────────────────────────────────
async function loadCacheStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const keys   = Object.keys(items).filter((k) => k.startsWith("lb:jw:"));
      const cached = keys.length;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTs = todayStart.getTime();

      let today = 0;
      for (const key of keys) {
        const entry = items[key];
        if (entry?.timestamp && entry.timestamp >= todayTs) today++;
      }

      resolve({ cached, today });
    });
  });
}

// ── Status detection ──────────────────────────────────────────────────────
async function detectStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return "unknown";
    return tab.url?.includes("justwatch.com") ? "active" : "inactive";
  } catch {
    return "unknown";
  }
}

// ── Render ────────────────────────────────────────────────────────────────
function renderStatus(state) {
  statusDot.className = `status-dot ${state}`;
  const messages = {
    active:   "Active on JustWatch",
    inactive: "Open JustWatch to use",
    unknown:  "Ready",
  };
  statusText.textContent = messages[state] ?? "Ready";
}

function renderSettings(settings) {
  toggleEnabled.checked = settings.enabled;
  toggleBadge.checked   = settings.showBadge;
  toggleHover.checked   = settings.showHoverCard;

  // Cache duration chips
  const days = settings.cacheDurationDays ?? 7;
  chipGroup.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("chip-active", parseInt(chip.dataset.days, 10) === days);
  });

  // Rating slider
  updateSliderUI(settings.minRating ?? 0);
}

/** Updates slider track fill and label */
function updateSliderUI(value) {
  ratingSlider.value = value;
  const pct = (value / 5) * 100;
  ratingSlider.style.setProperty("--pct", `${pct}%`);
  if (value === 0) {
    ratingValue.textContent = "Off";
    ratingValue.classList.add("is-off");
  } else {
    ratingValue.textContent = `\u2265 ${parseFloat(value).toFixed(1)}`;
    ratingValue.classList.remove("is-off");
  }
}

function renderStats({ cached, today }) {
  statCached.textContent = cached;
  statToday.textContent  = today;
}

// ── Event handlers ────────────────────────────────────────────────────────
async function onToggleChange() {
  const settings = await loadSettings();
  settings.enabled       = toggleEnabled.checked;
  settings.showBadge     = toggleBadge.checked;
  settings.showHoverCard = toggleHover.checked;
  await saveSettings(settings);
}

toggleEnabled.addEventListener("change", onToggleChange);
toggleBadge.addEventListener("change", onToggleChange);
toggleHover.addEventListener("change", onToggleChange);

// Cache duration chip clicks
chipGroup.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", async () => {
    chipGroup.querySelectorAll(".chip").forEach((c) => c.classList.remove("chip-active"));
    chip.classList.add("chip-active");
    const settings = await loadSettings();
    settings.cacheDurationDays = parseInt(chip.dataset.days, 10);
    await saveSettings(settings);
  });
});

// Rating filter slider — saves on every move, content script updates badges live
ratingSlider.addEventListener("input", async () => {
  const value = parseFloat(ratingSlider.value);
  updateSliderUI(value);
  const settings = await loadSettings();
  settings.minRating = value;
  await saveSettings(settings);
});

clearBtn.addEventListener("click", async () => {
  const items = await new Promise((res) => chrome.storage.local.get(null, res));
  const keysToRemove = Object.keys(items).filter((k) => k.startsWith("lb:jw:") || k.startsWith("lb:"));
  await new Promise((res) => chrome.storage.local.remove(keysToRemove, res));

  clearBtn.textContent = "Cache cleared ✓";
  clearBtn.classList.add("cleared");

  setTimeout(() => {
    clearBtn.textContent = "Clear cache";
    clearBtn.classList.remove("cleared");
    renderStats({ cached: 0, today: 0 });
  }, 2000);
});

// ── Init ──────────────────────────────────────────────────────────────────
async function init() {
  const [settings, stats, status] = await Promise.all([
    loadSettings(),
    loadCacheStats(),
    detectStatus(),
  ]);

  renderSettings(settings);
  renderStats(stats);
  renderStatus(status);
}

init();
