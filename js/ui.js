// Kleine UI-Hilfsfunktionen — bewusst framework-frei (kein Build-Schritt, Abschnitt 4).

function toast(message, kind = "") {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = `toast ${kind ? "toast-" + kind : ""}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; setTimeout(() => el.remove(), 300); }, 3200);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function precisionBadge(precision) {
  const map = { exact: ["exakt", "badge-exact"], approximate: ["ungefähr", "badge-approx"], unknown: ["unbekannt", "badge-unknown"] };
  const [label, cls] = map[precision] || map.unknown;
  return `<span class="chip ${cls}">${label}</span>`;
}

function fmtDate(iso) {
  if (!iso) return "unbekannt";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function fmtDayPart(dp) {
  const map = { dawn: "Morgendämmerung", morning: "Vormittag", midday: "Mittag", afternoon: "Nachmittag",
    evening: "Abend", dusk: "Abenddämmerung", night: "Nacht", unknown: "unbekannt" };
  return map[dp] || dp || "unbekannt";
}

function fmtProvValue(pvObj, digits = 1) {
  if (!pvObj || pvObj.value === null || pvObj.value === undefined) return "—";
  const v = typeof pvObj.value === "number" ? pvObj.value.toFixed(digits).replace(/\.0$/, "") : pvObj.value;
  return `${v}${pvObj.unit ? " " + pvObj.unit : ""}`;
}

function statusChip(status) {
  const map = { complete: ["✓ vollständig", "chip-green"], partial: ["⏳ teilweise", "chip-yellow"],
    failed: ["✕ fehlgeschlagen", "chip-red"], pending: ["… ausstehend", "chip-yellow"] };
  const [label, cls] = map[status] || ["?", ""];
  return `<span class="chip ${cls}">${label}</span>`;
}

window.UI = { toast, el, precisionBadge, fmtDate, fmtDayPart, fmtProvValue, statusChip };
