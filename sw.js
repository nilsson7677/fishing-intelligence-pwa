// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v25"; // v25: Phase HI-2C.1 E2E-Reparatur-Build (03.09.2026) — REIN
// vorsorglicher Cache-Version-Bump, KEINE Code-/Logikaenderung an Champion/Fangindex/SPOT_STATS/
// HI-1/HI-2A/HI-2A.1/HI-2B/HI-2C-Scoring/Cloud/DB. Grund: nach dem v24-Build wurde live beobachtet,
// dass js/spot-intelligence-data.js zunaechst 404'te; nach Behebung des 404 blieb
// window.FISpotIntelligenceData im Browser dennoch zeitweise "undefined" und das neue Debug-Panel
// erschien nicht — ein Symptombild, das exakt zum bereits einmal aufgetretenen Muster "gemischte
// GitHub-Pages-/Service-Worker-Cache-Version" passt (alte gecachte Antwort unter einer URL, die nie
// neu abgerufen wird, solange derselbe CACHE_NAME aktiv bleibt — der Fetch-Handler ist bewusst
// cache-first, siehe unten). Diese Session konnte die Live-Deployment-Umgebung nicht direkt
// inspizieren; ein Node/Playwright-Audit des aktuellen Codestands fand KEINEN Syntaxfehler und KEINE
// Logikluecke in js/spot-intelligence-data.js/js/app.js (echter Browser-E2E-Test, 18/18 bestanden,
// siehe HI2C1_E2E_REPAIR_REPORT.md) — der wahrscheinlichste Erklaerungsansatz bleibt eine veraltete
// Service-Worker-Cache-Instanz. Ein neuer CACHE_NAME erzwingt bei jedem Client einen vollstaendigen
// Neuabruf ALLER SHELL_FILES vom Netz (install-Event, cache.addAll) und loescht beim naechsten
// activate-Event JEDE Cache-Instanz mit abweichendem Namen (bestehende activate-Logik, unveraendert)
// — IndexedDB/Nutzerdaten sind davon nicht betroffen (siehe Lehre aus einem frueheren, aehnlichen
// Cache-Vorfall: nur Cache loeschen + SW neu registrieren, NIEMALS IndexedDB anfassen). v24: Phase HI-2C.1 "Spot Intelligence Metadata Layer" (03.09.2026) — NEUE Datei
// js/spot-intelligence-data.js (window.FISpotIntelligenceData): REINE, statische Datenschicht mit
// granularen physikalischen/geografischen Metadaten (Geometrie, Bathymetrie, Substrat, Habitat,
// kuenstliche Struktur, Hydrodynamik-Hypothesen, Ufer-/Boot-Zugriffsprofil, Provenance, Evidenzgrad,
// Unknowns) fuer alle 29 vom Nutzer autoritativ vorgegebenen Spots (Master-Handover Abschnitt 17/40).
// SPOT_INTELLIGENCE_SCORING_IMPACT ist strukturell "none" — die Datei wird von KEINER Scoring-Funktion
// gelesen (Champion/meerforelle-model.js, Challenger/challenger-state.js, HI-2B/
// hourly-window-intelligence.js, HI-2C/where-spot-intelligence.js bleiben unveraendert und referenzieren
// diese Datei an keiner Stelle, siehe Selbst-Audit im Implementierungsbericht). Kein neuer IndexedDB-Store,
// KEINE DB-Versionsaenderung (reine statische Konstante, kein Persistenzbedarf). Ergaenzt, NICHT ersetzt,
// die bestehenden, bewusst unangetasteten groeberen Spot-Layer FIMefoModel.SPOT_STATS
// (meerforelle-model.js, 14 Orte, historische Fangquoten) und SPOT_GEO_METADATA
// (hourly-intelligence.js, 13 Orte, lat/lon/shoreOrientationDeg fuer HI-2C). Optionaler Debug-Viewer
// "Spot Intelligence Metadata" unter ?hidebug=1 (falls in dieser Phase ergaenzt, siehe Implementierungs-
// bericht) zeigt AUSSCHLIESSLICH beschreibende Metadaten — kein Rating/Bonus/Fangwahrscheinlichkeit/
// Empfehlung/Rang. Champion/Fangindex/Tiers/SPOT_STATS/Wasserstandsmodell/Windmodell/Koederlogik/HI-1/
// HI-2A/HI-2A.1/HI-2B/HI-2C-Scoring-Code unveraendert (Auftrag Abschnitt 38 Scope Lock). v23: Phase HI-2C "WHERE Shadow Engine - Dynamic Spot Suitability & Top-3" (31.08.2026) — NEUE Datei js/where-spot-intelligence.js (window.FIWhereIntelligence): reine additive Konsumenten-Schicht, scope-begrenzt auf mefo x luebecker_bucht x shore (andere Kombinationen liefern unsupported/not_applicable). Nutzt EIN bereits geladenes HI-2A.1-Batch-Forecast plus die reine HI-2B-Rankingfunktion (kein zweiter Netzwerk-Request), aggregiert robuste Fensterbedingungen (Median/zirkulaeres Mittel, keine Peak-Stunde) und berechnet pro Spot rawSuitability = BASE + WAVE_ONSHORE_WEIGHT * (wave.onshoreWaveComponent > 0), GENAU EINE experimentelle biologische Regel (WAVE_ONSHORE_ACTIVATION, Grade C/D, hypothesisId H4) — Windgeometrie wird vollstaendig berechnet/gezeigt, aber bewusst NICHT gescort (Phase 2.5: berechnete Wind-Exposure lieferte OOS AUC 0,42-0,43, unter Zufallsniveau, identischer Ansatz). Keine historischen SPOT_STATS-Fangquoten im Score (nur Spot-IDs gelesen), keine absolute Fangwahrscheinlichkeit, kein "%". IndexedDB v7->v8 (NEUER Store where_spot_shadow_prediction, unveraenderliche Top-3-Predictions pro Fenster). Debug-Panel um "WHERE Intelligence"-Panel erweitert (?hidebug=1, weiterhin kein produktives UI, boat-Modus liefert bewusst keine Ufer-Top-3). Champion/Fangindex/Tiers/SPOT_STATS/Wasserstandsmodell/Windmodell/Koederlogik/HI-1/HI-2A/HI-2A.1/HI-2B-Code unveraendert. v22 (Phase HI-2B, 31.08.2026): WHEN Shadow Engine - Hourly Opportunity & 2-3h Window Ranking. — NEUE Datei js/hourly-window-intelligence.js (window.FIHourlyWindowIntelligence): reine additive Konsumenten-Schicht ueber dem live-verifizierten HI-2A.1-Batch-Forecast (buildHourlyForecastSeries), erstmals eine WHEN-Logik (relativeOpportunity pro Stunde, 2h/3h-Fenster, Tagesgruppierung Europe/Berlin, Daily-Contrast, Confidence getrennt von Opportunity). rawOpportunity = BASE + THERMAL_SOLAR_WEIGHT[thermalRegime] * lowSolarProxy(solarElevationDeg) — kontinuierliche Sigmoid-Transformation statt fester Uhrzeit/diskreter Lichtphase, alle Gewichte EXPERIMENTAL/dokumentiert. Explizit KEINE absolute Fangwahrscheinlichkeit, KEIN Windbonus, KEIN Wavebonus, KEIN Pegelbonus, KEIN Pressurebonus. IndexedDB v6->v7 (NEUER Store hourly_window_shadow_prediction, unveraenderliche Predictions pro lokalem Tag, keine volle Rohserie persistiert). Debug-Panel um "WHEN Intelligence"-Panel erweitert (?hidebug=1, weiterhin kein produktives UI). Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice/Spot-Namen/-Statistiken/Spot-Geo-Metadaten/HI-1/HI-2A/HI-2A.1-Code unveraendert. v21 (Phase HI-2A.1, 31.08.2026): Marine Provider Separation (getWaterTempRangeRaw/getWaveRangeRaw statt getMarineRangeRaw) + Forecast-Horizon-Fix, live verifiziert. v20 (Phase HI-2A, 31.08.2026): 120h-Batch-Forecast-Architektur, Spot-Geo-Modell mit Provenance. v19 (Phase HI-1, 30.08.2026): IndexedDB v5->v6 (Store hourly_shadow_snapshot), Solar-/Thermal-/Wind-Shore-Features, Shadow-Hypothesis-Registry.
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
  "./js/where-spot-intelligence.js",
  "./js/spot-intelligence-data.js",
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
