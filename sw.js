// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v22"; // v22: Phase HI-2B "WHEN Shadow Engine - Hourly Opportunity & 2-3h Window Ranking" (31.08.2026) — NEUE Datei js/hourly-window-intelligence.js (window.FIHourlyWindowIntelligence): reine additive Konsumenten-Schicht ueber dem live-verifizierten HI-2A.1-Batch-Forecast (buildHourlyForecastSeries), erstmals eine WHEN-Logik (relativeOpportunity pro Stunde, 2h/3h-Fenster, Tagesgruppierung Europe/Berlin, Daily-Contrast, Confidence getrennt von Opportunity). rawOpportunity = BASE + THERMAL_SOLAR_WEIGHT[thermalRegime] * lowSolarProxy(solarElevationDeg) — kontinuierliche Sigmoid-Transformation statt fester Uhrzeit/diskreter Lichtphase, alle Gewichte EXPERIMENTAL/dokumentiert. Explizit KEINE absolute Fangwahrscheinlichkeit, KEIN Windbonus, KEIN Wavebonus, KEIN Pegelbonus, KEIN Pressurebonus. IndexedDB v6->v7 (NEUER Store hourly_window_shadow_prediction, unveraenderliche Predictions pro lokalem Tag, keine volle Rohserie persistiert). Debug-Panel um "WHEN Intelligence"-Panel erweitert (?hidebug=1, weiterhin kein produktives UI). Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice/Spot-Namen/-Statistiken/Spot-Geo-Metadaten/HI-1/HI-2A/HI-2A.1-Code unveraendert. v21 (Phase HI-2A.1, 31.08.2026): Marine Provider Separation (getWaterTempRangeRaw/getWaveRangeRaw statt getMarineRangeRaw) + Forecast-Horizon-Fix, live verifiziert. v20 (Phase HI-2A, 31.08.2026): 120h-Batch-Forecast-Architektur, Spot-Geo-Modell mit Provenance. v19 (Phase HI-1, 30.08.2026): IndexedDB v5->v6 (Store hourly_shadow_snapshot), Solar-/Thermal-/Wind-Shore-Features, Shadow-Hypothesis-Registry.
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/db.js",
  "./js/sync.js",
  "./js/gazetteers.js",
  "./js/extractor.js",
  "./js/astro.js",
  "./js/providers.js",
  "./js/registry.js",
  "./js/enrichment.js",
  "./js/meerforelle-model.js",
  "./js/challenger-state.js",
  "./js/shadow.js",
  "./js/hourly-intelligence.js",
  "./js/hourly-window-intelligence.js",
  "./js/speech.js",
  "./js/seed-data.js",
  "./js/ui.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-192-maskable.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

// Herkunft der Domain, auf der die App selbst laeuft - NUR fuer diese wird der Cache-first-Pfad
// genutzt. Alles andere (externe APIs) geht direkt ans Netz, kein Caching, kein Vortaeuschen von
// Offline-Verfuegbarkeit fuer Umweltdaten.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return; // externe API-Aufrufe unangetastet durchreichen
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
