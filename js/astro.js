// NOAA Sunrise Equation — Port von Sprint-1 providers/astro.py. Laeuft vollstaendig offline,
// deterministisch, kein Netzwerk-/Ausfallrisiko (identische Formel, identischer Bugfix
// "days_since_j2000 statt absolutes Julianisches Datum" wie in der Python-Version).

function julianDayNoonUtc(dateUtcMidnight) {
  const d = dateUtcMidnight;
  const day = d.getUTCDate(), month = d.getUTCMonth() + 1, year = d.getUTCFullYear();
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function sunEventsJulian(lat, lonEast, dateUtcMidnight) {
  const lw = -lonEast;
  const Jdate = julianDayNoonUtc(dateUtcMidnight);
  const n = Math.round(Jdate - 2451545.0009 - lw / 360.0);
  const J_ = 2451545.0009 + lw / 360.0 + n;
  const daysSinceJ2000 = J_ - 2451545.0009;

  const M = ((357.5291 + 0.98560028 * daysSinceJ2000) % 360 + 360) % 360;
  const Mr = (M * Math.PI) / 180;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lam = ((M + 102.9372 + C + 180.0) % 360 + 360) % 360;
  const lamR = (lam * Math.PI) / 180;

  const Jtransit = J_ + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lamR);
  const sinDelta = Math.sin(lamR) * Math.sin((23.4397 * Math.PI) / 180);
  const delta = Math.asin(sinDelta);
  const latR = (lat * Math.PI) / 180;

  function hourAngle(hDeg) {
    const num = Math.sin((hDeg * Math.PI) / 180) - Math.sin(latR) * Math.sin(delta);
    const den = Math.cos(latR) * Math.cos(delta);
    const cosOmega = num / den;
    if (cosOmega > 1 || cosOmega < -1) return null;
    return (Math.acos(cosOmega) * 180) / Math.PI;
  }

  const out = { transit: Jtransit };
  for (const [label, hDeg] of [["sunrise_set", -0.833], ["civil", -6.0]]) {
    const omega = hourAngle(hDeg);
    if (omega === null) { out[`${label}_rise`] = null; out[`${label}_set`] = null; }
    else { out[`${label}_rise`] = Jtransit - omega / 360.0; out[`${label}_set`] = Jtransit + omega / 360.0; }
  }
  return out;
}

function julianToDate(J) {
  if (J === null || J === undefined) return null;
  const unixMs = (J - 2440587.5) * 86400000;
  return new Date(unixMs);
}

class NOAAAstroProvider {
  constructor() { this.name = "noaa_sunrise_equation_v1_offline"; }

  getSunEvents(lat, lon, dateUtcMidnight) {
    const nowIso = new Date().toISOString();
    const raw = sunEventsJulian(lat, lon, dateUtcMidnight);
    const dts = {
      sunrise: julianToDate(raw.sunrise_set_rise), sunset: julianToDate(raw.sunrise_set_set),
      civil_twilight_begin: julianToDate(raw.civil_rise), civil_twilight_end: julianToDate(raw.civil_set),
    };
    const events = {};
    for (const [key, dt] of Object.entries(dts)) {
      events[key] = {
        ok: dt !== null, value: null, unit: "iso_datetime_utc",
        station_or_gridpoint: `berechnet lat=${lat.toFixed(3)},lon=${lon.toFixed(3)}`,
        measured_at: dt ? dt.toISOString() : "", distance_km: 0.0,
        origin: "computed", quality: "hoch",
        extra: { algorithm: this.name, computed_at: nowIso,
          accuracy_note: "Sunrise-Equation-Naeherung, ~1 Min. Genauigkeit fuer mittlere Breiten" },
        error: dt ? null : "Sonnenauf-/untergang an diesem Ort/Datum nicht definiert (Polarregion)",
      };
    }
    if (dts.sunrise && dts.sunset) {
      const dayLenH = (dts.sunset - dts.sunrise) / 3600000;
      events.day_length_hours = {
        ok: true, value: Math.round(dayLenH * 100) / 100, unit: "hours",
        station_or_gridpoint: `berechnet lat=${lat.toFixed(3)},lon=${lon.toFixed(3)}`,
        origin: "computed", quality: "hoch", extra: { algorithm: this.name, computed_at: nowIso },
      };
    } else {
      events.day_length_hours = { ok: false, error: "sunrise/sunset nicht berechenbar" };
    }
    return events;
  }
}

// ---------------------------------------------------------------------------
// HOURLY INTELLIGENCE SHADOW (Phase HI-1, 30.08.2026): Sonnenhoehe (solar elevation) fuer einen
// BELIEBIGEN Zeitpunkt — rein additiv, nutzt dieselbe Deklinations-/Ekliptik-Herleitung wie
// sunEventsJulian() oben (identische Genauigkeitsklasse, ~1 Min./~0,1-0,2 Grad bei mittleren
// Breiten), damit Sonnenhoehe und Sonnenauf-/-untergang intern konsistent bleiben (z.B. Elevation
// am berechneten Sunrise-Zeitpunkt ≈ -0.833 Grad, siehe Test in hi1_hourly_intelligence_test.js).
// Reine Funktion des UTC-Zeitpunkts + Lat/Lon — Sonnenposition ist ASTRONOMISCH unabhaengig von der
// lokalen Zivilzeitzone/Sommerzeit (die Zeitzone ist ein zivilrechtliches Konstrukt, keine
// physikalische Groesse). Deshalb wird hier bewusst NUR mit dem UTC-Zeitstempel gerechnet — keine
// lokale Zeitzonen-/DST-Bibliothek noetig, keine neue Dependency (Auftrag Abschnitt 4/17: "etablierte
// vorhandene Library nutzen, falls geeignete Dependency vorhanden" — hier: derselbe Algorithmus-Stamm
// wie die bestehende NOAA-Sunrise-Equation, nur fuer einen beliebigen Zeitpunkt statt nur Auf-/
// Untergang, statt einer zusaetzlichen externen Bibliothek).
// NICHT veraendert: sunEventsJulian(), julianToDate(), NOAAAstroProvider — alles oben unangetastet.
// ---------------------------------------------------------------------------

const J2000_UNIX_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // 2000-01-01T12:00:00Z

function _solarEclipticLonRad(daysSinceJ2000) {
  const M = ((357.5291 + 0.98560028 * daysSinceJ2000) % 360 + 360) % 360;
  const Mr = (M * Math.PI) / 180;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lam = ((M + 102.9372 + C + 180.0) % 360 + 360) % 360;
  return (lam * Math.PI) / 180;
}

// Sonnenhoehe (Grad ueber Horizont, negativ = unter Horizont) fuer einen beliebigen UTC-Zeitpunkt.
// Standard-Naeherungsverfahren (Rektaszension/Deklination + Greenwich-Sternzeit -> Stundenwinkel),
// dieselbe Genauigkeitsklasse wie oben. dateUtc: beliebiger JS Date (absoluter Zeitpunkt, timezone-
// unabhaengig — Date speichert intern immer UTC-Millisekunden).
function solarElevationDeg(lat, lonEast, dateUtc) {
  const daysSinceJ2000 = (dateUtc.getTime() - J2000_UNIX_MS) / 86400000;
  const lamR = _solarEclipticLonRad(daysSinceJ2000);
  const eps = (23.4397 * Math.PI) / 180;
  const sinDelta = Math.sin(lamR) * Math.sin(eps);
  const delta = Math.asin(sinDelta);
  const cosDelta = Math.cos(delta);

  const alpha = Math.atan2(Math.sin(lamR) * Math.cos(eps), Math.cos(lamR));
  const alphaDeg = (alpha * 180) / Math.PI;

  // Greenwich-Sternzeit (Grad), Standardnaeherung (z.B. Meeus/Schlyter) — dieselbe Genauigkeitsklasse
  // wie die bestehende Sunrise-Equation oben.
  const gmstDeg = ((280.46061837 + 360.98564736629 * daysSinceJ2000) % 360 + 360) % 360;
  let hourAngleDeg = gmstDeg + lonEast - alphaDeg;
  hourAngleDeg = ((hourAngleDeg + 180) % 360 + 360) % 360 - 180; // auf -180..180 normieren
  const H = (hourAngleDeg * Math.PI) / 180;

  const latR = (lat * Math.PI) / 180;
  const sinElev = Math.sin(latR) * sinDelta + Math.cos(latR) * cosDelta * Math.cos(H);
  return (Math.asin(Math.max(-1, Math.min(1, sinElev))) * 180) / Math.PI;
}

// Sonnenmittag (Solar Transit, UTC) fuer den Kalendertag von dateUtcMidnight, an lat/lon — wird in
// hourly-intelligence.js gebraucht, um Daemmerung VOR (dawn) von Daemmerung NACH (dusk) dem
// Sonnenhoechststand zu unterscheiden. Nutzt exakt dieselbe Transit-Berechnung wie
// sunEventsJulian() oben (kein neuer Algorithmus).
function solarTransitUtc(lat, lonEast, dateUtcMidnight) {
  const raw = sunEventsJulian(lat, lonEast, dateUtcMidnight);
  return julianToDate(raw.transit);
}

window.FIAstro = { NOAAAstroProvider, solarElevationDeg, solarTransitUtc };
