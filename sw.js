// Service Worker — Fishing Intelligence Co-Pilot
// Cache-first fuer den App-Shell (HTML/CSS/JS/Icons), damit die App OHNE Netz startet
// (Abschnitt 4/34: Offline-Grundfunktion). Externe API-Aufrufe (Open-Meteo/Pegelonline) werden
// NICHT durch den Service Worker geleitet/gecacht - die laufen direkt aus enrichment.js per
// fetch() und muessen bei Ausfall ehrlich fehlschlagen (Retry-/Pending-Prinzip aus Sprint 1
// bleibt erhalten, siehe js/enrichment.js).

const CACHE_NAME = "fishintel-shell-v18"; // v18: Phase 6B "Automatic Cloud Backup" (26.08.2026) — IndexedDB v4->v5 (rein additiv, neuer Store sync_queue), neues js/sync.js (Supabase-Client, lokale Sync-Queue, Retry, Magic-Link-Auth, Cloud-Status), 8 Kernstores werden nach erfolgreichem lokalen Speichern zusaetzlich zur Cloud (Supabase, EU-Region) gesichert — LOCAL FIRST: Cloud-SDK wird dynamisch vom CDN geladen und blockiert nie den App-Start, jeder Cloud-Fehler bleibt lokal folgenlos. Neue "☁️ Cloud-Sicherung"-Kachel in Insights (Login/Status/manueller Sync), manuelles JSON-Backup unveraendert daneben bestehen. Champion/Fangindex/Tiers/Wasserstandsmodell/Windmodell/Spot-Ranking/Lure-Intelligence/Voice unveraendert.
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
