// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v21"; // v21: Phase HI-2A.1 "Marine Provider Separation + Forecast Horizon Fix" (31.08.2026, echter Livetest-Hotfix) — providers.js: getMarineRangeRaw() (kombinierter SST+Wellen-Request unter erzwungenem Wellenmodell) ersetzt durch ZWEI getrennte Methoden getWaterTempRangeRaw() (SST, KEIN erzwungenes Modell -> behebt die Livetest-Regression "waterTempC durchgehend null") und getWaveRangeRaw() (Wellen, Modell von dwd_ewam auf ecmwf_wam umgestellt, da dwd_ewam live weiterhin provider_null lieferte); neuer waterTempSourceStatus + waterTempModel/waveModel-Provenance; neuer "outside_coverage"-Status (_isOutsideKnownCoverage, dokumentiertes GFS-Wave-0.16°-Limit). hourly-intelligence.js: _mapForecastHour() nutzt die getrennten Requests (keine SST/Wellen-Kopplung mehr), forecastHorizonHours im Batch-Kontext korrigiert (Abstand zum Batch-Start startHour, nicht zur ggf. nicht-vollen-Stunde generatedAt — behebt "h=0 -> -1"-Regression). Debug-Panel um waterTempSourceStatus/waterTempModel/waveSourceStatus/waveModel erweitert. Weiterhin 4 statt 3 Batch-Requests total (bewusst akzeptiert, siehe Bericht), weiterhin KEINE stuendlichen Einzelrequests. Weiterhin HOURLY_INTELLIGENCE_MODE = "SHADOW", keine Fanggewichtung, kein Window Builder, Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice/Spot-Namen/-Statistiken/Spot-Geo-Metadaten unveraendert. v20 (Phase HI-2A, 31.08.2026): 120h-Batch-Forecast-Architektur, Spot-Geo-Modell mit Provenance. v19 (Phase HI-1, 30.08.2026): IndexedDB v5->v6 (Store hourly_shadow_snapshot), Solar-/Thermal-/Wind-Shore-Features, Shadow-Hypothesis-Registry.
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
