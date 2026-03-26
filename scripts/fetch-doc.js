#!/usr/bin/env node
/**
 * fetch-doc.js
 * Fetches the Patagonia trip Google Doc and writes data.json with parsed
 * costs and itinerary so index.html can render dynamically.
 *
 * Usage:  node scripts/fetch-doc.js
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DOC_ID = "1ZPkHp-xo_Jk9tohyX22k2jvwQHMoA5pjbc7Fnr_ZIt4";
const EXPORT_URL = `https://docs.google.com/document/d/${DOC_ID}/export?format=txt`;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parse an ARS amount string like "$476.000" or "$361.986,4" → number */
function parseARS(str) {
  if (!str) return null;
  // Remove $ and spaces, replace thousand-sep dots, replace decimal comma
  const clean = str.replace(/\$/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isNaN(n) ? null : Math.round(n);
}

/** Parse a USD amount string like "$57.98" or "57,98" → number */
function parseUSD(str) {
  if (!str) return null;
  const clean = str.replace(/\$/g, "").replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(clean);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

/** Find first ARS amount in a line (format: $NNN.NNN or $NNN.NNN,N) */
function firstARS(line) {
  const m = line.match(/\$\s*([\d]+(?:[.,][\d]+)*)/);
  return m ? parseARS(m[0]) : null;
}

/** Find first USD amount in a line (small number after "USD" or ~$xx.xx) */
function firstUSD(line) {
  const m = line.match(/\$\s*([\d]+\.\d{2})\s*USD|USD\s*\$?\s*([\d]+(?:[.,]\d+)?)/i);
  if (!m) return null;
  return parseUSD(m[1] ?? m[2]);
}

// ── parser ───────────────────────────────────────────────────────────────────

function parseDoc(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ── Costs ────────────────────────────────────────────────────────────────

  const costs = {
    car: null,
    accommodations: [],
    activities: [],
  };

  // Scan ALL lines for the known cost patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Car ──────────────────────────────────────────────────────────────
    if (/AUTO/i.test(line) && /EFECTIVO/i.test(line)) {
      const ars = firstARS(line);
      if (ars) {
        costs.car = {
          label: "Andares Rent Car · Reserva #3470",
          ars,
          note: "Efectivo al retirar en aeropuerto",
          status: "cash",
        };
      }
      continue;
    }

    // ── Accommodation: Bariloche (seña + remaining in one line) ──────────
    // Pattern: "ALOJAMIENTO ... Bariloche ... SE PAGÓ SEÑA $42.600 (30 USD) RESTAN 57.98 USD $1420 APROX EL TC $82.332APROX"
    if (/BARILOCHE/i.test(line) && /SE PAG[OÓ]|SE[ÑN]A/i.test(line)) {
      const seniaMatch = line.match(/SE[ÑN]A\s*\$\s*([\d.,]+)/i);
      const seniaUsdMatch = line.match(/SE[ÑN]A[^)]*\(\s*([\d.]+)\s*USD\s*\)/i);
      const restanUsdMatch = line.match(/RESTAN\s+([\d.,]+)\s*USD/i);
      // The remaining ARS is the LAST "$NNN.NNN APROX" in the line (not the TC)
      const allAprox = [...line.matchAll(/\$\s*([\d.,]+)\s*APROX/gi)];
      const restanArsMatch = allAprox.length > 0 ? allAprox[allAprox.length - 1] : null;

      const seniaArs  = seniaMatch    ? parseARS("$" + seniaMatch[1])          : null;
      const seniaUsd  = seniaUsdMatch ? parseFloat(seniaUsdMatch[1])            : null;
      const restanUsd = restanUsdMatch ? parseFloat(restanUsdMatch[1].replace(",", ".")) : null;
      const restanArs = restanArsMatch ? parseARS("$" + restanArsMatch[1])      : null;

      const ars = restanArs ?? firstARS(line);
      if (ars && !costs.accommodations.find(a => a.location === "Bariloche")) {
        costs.accommodations.push({
          location: "Bariloche",
          address: "1760 Eduardo Elordi",
          dates: "Abr 3–4",
          ars,
          usd: restanUsd,
          note: seniaArs
            ? `Seña pagada $${seniaArs.toLocaleString("es-AR")}${seniaUsd ? ` (${seniaUsd} USD)` : ""} · resta pagar`
            : "Resta pagar",
          status: "partial",
        });
      }
      continue;
    }

    // ── Skip bottom summary line for Bariloche (already captured above) ──
    if (/BARILOCHE/i.test(line) && /RESTAN/i.test(line) && !/SE[ÑN]A/i.test(line)) {
      // Only use this if we don't already have Bariloche
      if (!costs.accommodations.find(a => a.location === "Bariloche")) {
        const ars = firstARS(line);
        if (ars) {
          costs.accommodations.push({
            location: "Bariloche",
            address: "1760 Eduardo Elordi",
            dates: "Abr 3–4",
            ars,
            usd: null,
            note: "Resta pagar",
            status: "partial",
          });
        }
      }
      continue;
    }

    // ── Accommodation: Villa La Angostura ────────────────────────────────
    if (/ANGOSTURA/i.test(line) && /\$[\d]/.test(line) && !/ACTIVIDAD/i.test(line)) {
      const ars = firstARS(line);
      // Extract USD: look for pattern like "147.91 USD" or "$147.91"
      const usdMatch = line.match(/([\d]+[.,][\d]{2})\s*USD/i);
      const usd = usdMatch
        ? parseFloat(usdMatch[1].replace(",", "."))
        : ars ? Math.round(ars / 1420 * 100) / 100 : null;
      if (ars && !costs.accommodations.find(a => a.location === "Villa La Angostura")) {
        costs.accommodations.push({
          location: "Villa La Angostura",
          address: "Blvd. Nahuel Huapi 1911",
          dates: "Abr 5–6",
          ars,
          usd,
          note: "Boulevard Nahuel Huapi 1911",
          status: "pending",
        });
      }
      continue;
    }

    // ── Accommodation: 50% before arrival (Villa Traful) ─────────────────
    if (/50%.*D[IÍ]AS.*ANTES|ANTES.*LLEGADA/i.test(line) && /\$[\d]/.test(line)) {
      const ars = firstARS(line);
      const usdMatch = line.match(/([\d]+[.,][\d]{2})\s*USD/i);
      const usd = usdMatch
        ? parseFloat(usdMatch[1].replace(",", "."))
        : ars ? Math.round(ars / 1420 * 100) / 100 : null;
      const dateMatch = line.match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
      const callDate = dateMatch ? dateMatch[1] : "1/4/2026";
      if (ars && !costs.accommodations.find(a => a.location === "Villa Traful")) {
        costs.accommodations.push({
          location: "Villa Traful",
          address: "Ruta 65 km 35",
          dates: "Abr 7–8",
          ars,
          usd,
          note: `Pagar 50% antes del ${callDate}`,
          status: "attention",
        });
      }
      continue;
    }

    // ── Accommodation: advance charge (San Martín) ────────────────────────
    if (/ADELANTADO|BOOKING/i.test(line) && /\$[\d]/.test(line)) {
      const ars = firstARS(line);
      const usdMatch = line.match(/([\d]+[.,][\d]{2})\s*USD/i);
      const usd = usdMatch
        ? parseFloat(usdMatch[1].replace(",", "."))
        : ars ? Math.round(ars / 1420 * 100) / 100 : null;
      if (ars && !costs.accommodations.find(a => a.location === "San Martín de los Andes")) {
        costs.accommodations.push({
          location: "San Martín de los Andes",
          address: "Coronel Perez 1127",
          dates: "Abr 9–11",
          ars,
          usd,
          note: "Se carga el importe total por adelantado",
          status: "pending",
        });
      }
      continue;
    }

    // ── Activity: Bosque Sumergido (must be before CADA UNO check) ───────
    if (/BOSQUE SUMERGIDO|TRAFUL EXTREMO/i.test(line) && /\$[\d]/.test(line)) {
      const ars = firstARS(line);
      const phone = line.match(/\+54[\s\d-]+/)?.[0]?.trim() ?? "+54 9 2944 21-0759";
      if (ars && !costs.activities.find(a => /Bosque Sumergido/i.test(a.name))) {
        costs.activities.push({
          name: "Bosque Sumergido de Villa Traful",
          ars,
          note: `Traful Extremo · ${phone} · 2 hs · Abr 8`,
          status: "pending",
        });
      }
      continue;
    }

    // ── Activity: Isla Victoria / CADA UNO pattern ───────────────────────
    // The cost line in the doc: "$140.000 CADA UNO + INGRESO AL PARQUE $7000 CADA UNO"
    if (/CADA UNO/i.test(line) && /\$[\d]/.test(line)) {
      // Extract first amount (Isla Victoria)
      const allAmounts = [...line.matchAll(/\$\s*([\d]+(?:[.,][\d]+)*)/g)].map(m => parseARS(m[0]));
      const islaArs = allAmounts[0];
      const parkArs = allAmounts[1] ?? 7000;
      if (islaArs && !costs.activities.find(a => /Isla Victoria/i.test(a.name))) {
        costs.activities.push({
          name: "Isla Victoria + Bosque de Arrayanes",
          ars: islaArs,
          note: "Por persona · Abr 4",
          status: "pending",
        });
      }
      if (parkArs && !costs.activities.find(a => /Parque/i.test(a.name))) {
        costs.activities.push({
          name: "Ingreso Parque Nacional",
          ars: parkArs,
          note: "Ticket día 1 → 50% descuento día 2",
          status: "pending",
        });
      }
      continue;
    }

    // Also catch Isla Victoria / Arrayanes mentioned with a $ on the same line
    if (/ISLA VICTORIA|ARRAYANES/i.test(line) && /\$[\d]/.test(line)) {
      const ars = firstARS(line);
      if (ars && !costs.activities.find(a => /Isla Victoria/i.test(a.name))) {
        costs.activities.push({
          name: "Isla Victoria + Bosque de Arrayanes",
          ars,
          note: "Por persona · Abr 4",
          status: "pending",
        });
      }
      continue;
    }
  }

  // ── Fallbacks if parsing found nothing ─────────────────────────────────
  if (!costs.car) {
    costs.car = { label: "Andares Rent Car · Reserva #3470", ars: 476000, note: "Efectivo al retirar en aeropuerto", status: "cash" };
  }
  if (costs.accommodations.length === 0) {
    costs.accommodations = [
      { location: "Bariloche", address: "1760 Eduardo Elordi", dates: "Abr 3–4", ars: 82332, usd: 57.98, note: "Seña pagada $42.600 (30 USD) · resta pagar", status: "partial" },
      { location: "Villa La Angostura", address: "Blvd. Nahuel Huapi 1911", dates: "Abr 5–6", ars: 210032, usd: 147.91, note: "Boulevard Nahuel Huapi 1911", status: "pending" },
      { location: "Villa Traful", address: "Ruta 65 km 35", dates: "Abr 7–8", ars: 361986, usd: 254.92, note: "Pagar 50% antes del 1/4/2026", status: "attention" },
      { location: "San Martín de los Andes", address: "Coronel Perez 1127", dates: "Abr 9–11", ars: 194838, usd: 137.21, note: "Se carga el importe total por adelantado", status: "pending" },
    ];
  }
  if (costs.activities.length === 0) {
    costs.activities = [
      { name: "Isla Victoria + Bosque de Arrayanes", ars: 140000, note: "Por persona · Abr 4", status: "pending" },
      { name: "Ingreso Parque Nacional", ars: 7000, note: "Ticket día 1 → 50% descuento día 2", status: "pending" },
      { name: "Bosque Sumergido de Villa Traful", ars: 120000, note: "Traful Extremo · +54 9 2944 21-0759 · 2 hs · Abr 8", status: "pending" },
    ];
  }

  return costs;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching Google Doc…");
  let text;
  try {
    const res = await fetch(EXPORT_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
    console.log(`Fetched ${text.length} chars`);
  } catch (err) {
    console.error("Failed to fetch doc:", err.message);
    process.exit(1);
  }

  const costs = parseDoc(text);

  const data = {
    lastUpdated: new Date().toISOString(),
    docId: DOC_ID,
    costs,
  };

  const outPath = join(ROOT, "data.json");
  writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`✅ data.json written (${costs.accommodations.length} accommodations, ${costs.activities.length} activities)`);
}

main();
