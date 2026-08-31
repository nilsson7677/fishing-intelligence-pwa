// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v20"; // v20: Phase HI-2A "Forecast Time Series & Spot Foundation" (31.08.2026) — additive Erweiterung von js/hourly-intelligence.js (120h-Batch-Forecast buildHourlyForecastSeries() mit striktem Timestamp-Matching statt N x 120 HTTP-Requests, Spot-Geo-Modell mit Provenance fuer 13 bestehende Meerforellen-Spots, computeWaveShoreFeatures + spot-relative Wind/Wellen-Features) und js/providers.js (getHourlyRangeRaw/getMarineRangeRaw als neue Batch-Methoden, Wave-Provider-Fix ueber expliziten models=dwd_ewam-Parameter statt best_match, waveSourceStatus-Feld). Zweites Debug-Panel unter ?hidebug=1 in app.js (Batch-Forecast-Coverage-Uebersicht, weiterhin rein diagnostisch). Weiterhin HOURLY_INTELLIGENCE_MODE = "SHADOW": rein experimentell, produktiv nirgends sichtbar/wirksam, kein Opportunity-Score, kein Fenster-/Spot-Ranking, keine neue Fanggewichtung. Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice/Spot-Namen/-Statistiken unveraendert. v19 (Phase HI-1, 30.08.2026): IndexedDB v5->v6 (Store hourly_shadow_snapshot), Solar-/Thermal-/Wind-Shore-Features, Shadow-Hypothesis-Registry, unveraenderliche Shadow-Snapshots.
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
