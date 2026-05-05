import { useState, useCallback, useMemo, useRef } from "react";

// ─── palette ────────────────────────────────────────────────────────────────
const C = {
  bg: "#FAFAF8",
  bgCard: "#FFFFFF",
  bgSidebar: "#F4F3EF",
  navy: "#0D1B2A",
  navyMid: "#1E3A5F",
  navyLight: "#2E5077",
  orange: "#E8620A",
  orangeLight: "#F07A30",
  orangePale: "#FDF0E8",
  border: "#E2DDD6",
  borderDark: "#C8C0B4",
  textPrimary: "#0D1B2A",
  textSecondary: "#4A5568",
  textMuted: "#8A9AB0",
};

const TNR = "'Times New Roman', Times, serif";

// ─── HMLR schema ─────────────────────────────────────────────────────────────
const PROPERTY_TYPES = { D: "Detached", S: "Semi-detached", T: "Terraced", F: "Flat", O: "Other" };
const TENURE = { F: "Freehold", L: "Leasehold" };
const OLD_NEW = { Y: "New Build", N: "Established" };

// PPD category A = standard price paid, B = additional price paid
const PPD_CATEGORY = {
  A: "Standard Sale",
  B: "Additional Price Paid",
};

// Record status
const RECORD_STATUS = {
  A: "Added",
  C: "Changed",
  D: "Deleted",
};

// ─── Anomaly detection ───────────────────────────────────────────────────────
function detectAnomalies(rows) {
  const bySector = {};
  rows.forEach(r => {
    const sector = r.postcode ? r.postcode.slice(0, -2).trim() : "UNKNOWN";
    if (!bySector[sector]) bySector[sector] = [];
    bySector[sector].push(r);
  });

  const anomalies = [];
  Object.entries(bySector).forEach(([sector, sRows]) => {
    if (sRows.length < 3) return;
    const byType = {};
    sRows.forEach(r => {
      if (!byType[r.property_type]) byType[r.property_type] = [];
      byType[r.property_type].push(r.price);
    });
    sRows.forEach(r => {
      const peers = byType[r.property_type] || [];
      if (peers.length < 2) return;
      const mean = peers.reduce((a, b) => a + b, 0) / peers.length;
      const std = Math.sqrt(peers.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / peers.length);
      if (std === 0) return;
      const zScore = (r.price - mean) / std;
      const discountPct = ((mean - r.price) / mean) * 100;
      if (zScore < -1.5 && discountPct > 25) {
        anomalies.push({
          ...r, sector,
          mean: Math.round(mean), std: Math.round(std),
          zScore: Math.round(zScore * 100) / 100,
          discountPct: Math.round(discountPct),
          score: Math.min(100, Math.round(Math.abs(zScore) * 20 + discountPct * 0.5)),
          comparables: peers.length,
        });
      }
    });
  });
  return anomalies.sort((a, b) => b.score - a.score);
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  const rows = [];
  lines.forEach(line => {
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { fields.push(cur); cur = ""; continue; }
      cur += c;
    }
    fields.push(cur);
    if (fields.length < 14) return;
    const price = parseInt(fields[1]);
    if (!price || price <= 0) return;
    rows.push({
      id: fields[0], price, date: fields[2], postcode: fields[3],
      property_type: fields[4] || "O",
      old_new: fields[5] || "",
      duration: fields[6] || "",
      paon: fields[7], saon: fields[8], street: fields[9], locality: fields[10],
      town: fields[11], district: fields[12], county: fields[13],
      ppd_category: fields[14] || "A",
      record_status: fields[15] || "A",
    });
  });
  return rows;
}

async function generateNarrative(site) {
  const prompt = `You are a property investment analyst writing a lead report for a UK property investor.

A property has been flagged as a statistical anomaly in HM Land Registry price paid data — it sold significantly below the local market rate, suggesting a distressed sale, probate, or connected-party transfer.

Site details:
- Address: ${[site.paon, site.saon, site.street, site.locality, site.town].filter(Boolean).join(", ")}
- Postcode: ${site.postcode} (sector: ${site.sector})
- Sale price: £${site.price.toLocaleString()}
- Local sector average (${PROPERTY_TYPES[site.property_type] || site.property_type}): £${site.mean.toLocaleString()}
- Discount vs average: ${site.discountPct}%
- Statistical deviation (z-score): ${site.zScore}
- Property type: ${PROPERTY_TYPES[site.property_type] || site.property_type}
- Tenure: ${TENURE[site.duration] || site.duration}
- Sale category: ${PPD_CATEGORY[site.ppd_category] || site.ppd_category}
- New/Established: ${OLD_NEW[site.old_new] || "Unknown"}
- Sale date: ${site.date}
- Comparables in sector: ${site.comparables}
- Opportunity score: ${site.score}/100

Write a concise 3-paragraph investor briefing:
1. What the anomaly signals and likely reasons (distressed sale, probate, divorce, connected party)
2. The opportunity — what an investor could do (refurb and sell, hold for rental yield, flip)
3. Recommended immediate next step and key risk

Be direct, professional, no fluff. Do not use bullet points. Max 200 words total.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await response.json();
  return data.content?.[0]?.text || "Unable to generate narrative.";
}

// ─── Score badge ─────────────────────────────────────────────────────────────
function ScoreBadge({ score }) {
  const bg = score >= 80 ? C.orange : score >= 60 ? C.navyMid : C.textMuted;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 48, height: 48, borderRadius: "50%", background: bg,
      color: "#fff", fontFamily: TNR,
      fontSize: 15, fontWeight: 700, flexShrink: 0,
    }}>
      {score}
    </div>
  );
}

// ─── Tag chip ────────────────────────────────────────────────────────────────
function Tag({ label, value, accent, navy }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 2,
      padding: "6px 10px", borderRadius: 6,
      background: accent ? C.orangePale : navy ? "#EBF0F7" : "#F4F3EF",
      border: `1px solid ${accent ? "#F0C4A0" : navy ? "#C2D0E2" : C.border}`,
    }}>
      <span style={{ fontSize: 9, letterSpacing: 1.5, color: C.textMuted, fontFamily: TNR, textTransform: "uppercase" }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: accent ? C.orange : navy ? C.navyMid : C.navy, fontFamily: TNR }}>{value}</span>
    </div>
  );
}

// ─── Sale category pill ───────────────────────────────────────────────────────
function CategoryPill({ ppd_category, old_new }) {
  const catLabel = PPD_CATEGORY[ppd_category] || ppd_category || "Standard Sale";
  const buildLabel = OLD_NEW[old_new] || "Established";
  const isNewBuild = old_new === "Y";
  const isAdditional = ppd_category === "B";

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
      <span style={{
        display: "inline-block", padding: "3px 10px", borderRadius: 20,
        fontSize: 11, fontFamily: TNR, fontWeight: 700,
        background: isAdditional ? "#FFF3E0" : "#E8F5E9",
        color: isAdditional ? "#E65100" : "#2E7D32",
        border: `1px solid ${isAdditional ? "#FFCC80" : "#A5D6A7"}`,
        letterSpacing: 0.3,
      }}>
        {catLabel}
      </span>
      <span style={{
        display: "inline-block", padding: "3px 10px", borderRadius: 20,
        fontSize: 11, fontFamily: TNR, fontWeight: 700,
        background: isNewBuild ? "#E3F2FD" : "#F4F3EF",
        color: isNewBuild ? "#1565C0" : C.textSecondary,
        border: `1px solid ${isNewBuild ? "#90CAF9" : C.border}`,
        letterSpacing: 0.3,
      }}>
        {buildLabel}
      </span>
    </div>
  );
}

// ─── Site card ───────────────────────────────────────────────────────────────
function SiteCard({ site, onAnalyse }) {
  const [narrative, setNarrative] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const address = [site.paon, site.saon, site.street, site.locality, site.town].filter(Boolean).join(", ");

  const handleAnalyse = async () => {
    if (narrative) { setExpanded(!expanded); return; }
    setLoading(true);
    const text = await generateNarrative(site);
    setNarrative(text);
    setExpanded(true);
    setLoading(false);
    onAnalyse(site.id, text);
  };

  return (
    <div style={{
      background: C.bgCard, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "20px 22px", marginBottom: 10,
      boxShadow: "0 1px 3px rgba(13,27,42,0.06)",
      transition: "box-shadow 0.2s, border-color 0.2s",
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = C.orange; e.currentTarget.style.boxShadow = "0 4px 16px rgba(232,98,10,0.1)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.boxShadow = "0 1px 3px rgba(13,27,42,0.06)"; }}
    >
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <ScoreBadge score={site.score} />
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Top row: postcode/type + price */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: 2, color: C.orange, fontFamily: TNR, marginBottom: 3, textTransform: "uppercase" }}>
                {site.postcode} · {PROPERTY_TYPES[site.property_type] || site.property_type} · {TENURE[site.duration] || site.duration}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, fontFamily: TNR, lineHeight: 1.3 }}>
                {address || "Address unavailable"}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3, fontFamily: TNR }}>
                {site.town}{site.district ? ` · ${site.district}` : ""} · {site.date?.slice(0, 10)}
              </div>

              {/* Sale category pills */}
              <CategoryPill ppd_category={site.ppd_category} old_new={site.old_new} />
            </div>

            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 24, fontWeight: 700, color: C.navy, fontFamily: TNR }}>
                £{site.price.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, fontFamily: TNR }}>
                avg £{site.mean.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <Tag label="Below Market" value={`${site.discountPct}%`} accent />
            <Tag label="Z-Score" value={site.zScore} navy />
            <Tag label="Comparables" value={site.comparables} />
            <Tag label="Sector" value={site.sector} />
          </div>

          {/* AI brief button */}
          <div style={{ marginTop: 12 }}>
            <button onClick={handleAnalyse} disabled={loading} style={{
              background: loading ? C.orangePale : C.orange,
              border: "none", color: loading ? C.orange : "#fff",
              borderRadius: 6, padding: "7px 18px", fontSize: 12,
              fontFamily: TNR, letterSpacing: 0.5,
              cursor: loading ? "wait" : "pointer", transition: "all 0.2s",
              fontWeight: 700,
            }}>
              {loading ? "Analysing..." : narrative ? (expanded ? "▲ Hide Brief" : "▼ Show Brief") : "⚡ AI Brief"}
            </button>
          </div>

          {/* Expanded narrative */}
          {expanded && narrative && (
            <div style={{
              marginTop: 14, padding: "16px 18px",
              background: C.orangePale,
              border: `1px solid #F0C4A0`,
              borderLeft: `3px solid ${C.orange}`,
              borderRadius: 8,
              fontSize: 14, lineHeight: 1.8, color: C.textPrimary,
              fontFamily: TNR,
            }}>
              {narrative}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Upload zone ─────────────────────────────────────────────────────────────
function UploadZone({ onData }) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState("");
  const inputRef = useRef();

  const process = async (file) => {
    setStatus(`Reading ${file.name}…`);
    const text = await file.text();
    setStatus("Parsing CSV…");
    const rows = parseCSV(text);
    setStatus(`Detecting anomalies across ${rows.length.toLocaleString()} transactions…`);
    await new Promise(r => setTimeout(r, 80));
    const anomalies = detectAnomalies(rows);
    setStatus("");
    onData(rows, anomalies);
  };

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) process(file);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: 40, background: C.bg }}>

      {/* Logo */}
      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <span style={{ color: C.orange, fontSize: 18, fontWeight: 700 }}>⌖</span>
        </div>
        <span style={{ fontFamily: TNR, fontSize: 22, fontWeight: 700, color: C.navy, letterSpacing: -0.3 }}>LandSignal</span>
      </div>

      <div style={{ fontFamily: TNR, fontSize: 40, fontWeight: 700, color: C.navy, textAlign: "center", marginBottom: 12, lineHeight: 1.2, maxWidth: 560 }}>
        Find distressed property<br /><span style={{ color: C.orange }}>before anyone else does</span>
      </div>
      <div style={{ fontFamily: TNR, fontSize: 16, color: C.textSecondary, marginBottom: 48, textAlign: "center", maxWidth: 440, lineHeight: 1.7 }}>
        Upload your HMLR Price Paid CSV. The engine flags statistical anomalies — properties that sold 25%+ below sector average — and generates an AI investor brief for each one.
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          width: "100%", maxWidth: 480,
          border: `2px dashed ${dragging ? C.orange : C.borderDark}`,
          borderRadius: 16, padding: "52px 40px", textAlign: "center",
          cursor: "pointer", transition: "all 0.2s",
          background: dragging ? C.orangePale : C.bgCard,
          boxShadow: dragging ? `0 0 0 4px rgba(232,98,10,0.1)` : "0 2px 8px rgba(13,27,42,0.06)"
        }}
      >
        <div style={{ fontSize: 36, marginBottom: 14 }}>📂</div>
        <div style={{ fontFamily: TNR, fontSize: 19, color: C.navy, marginBottom: 8, fontWeight: 700 }}>
          Drop your HMLR CSV here
        </div>
        <div style={{ fontFamily: TNR, fontSize: 13, color: C.textMuted }}>
          {status || "or click to browse · standard price paid format · no headers needed"}
        </div>
        <input ref={inputRef} type="file" accept=".csv,.txt" style={{ display: "none" }}
          onChange={e => { if (e.target.files[0]) process(e.target.files[0]); }} />
      </div>

      {/* Stats row */}
      <div style={{ marginTop: 48, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, maxWidth: 480, width: "100%" }}>
        {[
          { n: "25%+", label: "below local avg" },
          { n: "−1.5σ", label: "z-score threshold" },
          { n: "10s", label: "to scan full dataset" },
        ].map(({ n, label }) => (
          <div key={label} style={{ textAlign: "center", padding: "18px 10px", background: C.bgCard, borderRadius: 10, border: `1px solid ${C.border}`, boxShadow: "0 1px 4px rgba(13,27,42,0.05)" }}>
            <div style={{ fontFamily: TNR, fontSize: 24, color: C.orange, fontWeight: 700 }}>{n}</div>
            <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, marginTop: 4, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Export ──────────────────────────────────────────────────────────────────
function exportCSV(anomalies) {
  const headers = ["Score","Address","Postcode","Town","County","Property Type","Tenure","Sale Category","New/Established","Sale Price","Sector Avg","Discount %","Z-Score","Comparables","Sale Date"];
  const rows = anomalies.map(s => [
    s.score,
    [s.paon, s.saon, s.street, s.locality].filter(Boolean).join(" "),
    s.postcode, s.town, s.county,
    PROPERTY_TYPES[s.property_type] || s.property_type,
    TENURE[s.duration] || s.duration,
    PPD_CATEGORY[s.ppd_category] || s.ppd_category || "Standard Sale",
    OLD_NEW[s.old_new] || "Established",
    s.price, s.mean, s.discountPct, s.zScore, s.comparables,
    s.date?.slice(0, 10)
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "land_anomalies.csv"; a.click();
}

// ─── Sidebar filter button ────────────────────────────────────────────────────
function FilterBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      display: "block", width: "100%", textAlign: "left", padding: "7px 10px",
      background: active ? C.navyMid : "transparent",
      border: `1px solid ${active ? C.navyMid : "transparent"}`,
      borderRadius: 6, color: active ? "#fff" : C.textSecondary,
      fontFamily: TNR, fontSize: 13, cursor: "pointer",
      marginBottom: 3, transition: "all 0.15s"
    }}>
      {children}
    </button>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [rows, setRows] = useState([]);
  const [anomalies, setAnomalies] = useState([]);
  const [narratives, setNarratives] = useState({});
  const [filters, setFilters] = useState({ minScore: 60, type: "ALL", tenure: "ALL", category: "ALL", search: "" });
  const [sort, setSort] = useState("score");

  const onData = (r, a) => { setRows(r); setAnomalies(a); };

  const filtered = useMemo(() => {
    return anomalies
      .filter(s => s.score >= filters.minScore)
      .filter(s => filters.type === "ALL" || s.property_type === filters.type)
      .filter(s => filters.tenure === "ALL" || s.duration === filters.tenure)
      .filter(s => filters.category === "ALL" || s.ppd_category === filters.category)
      .filter(s => {
        if (!filters.search) return true;
        const q = filters.search.toLowerCase();
        return [s.postcode, s.town, s.district, s.county, s.street].join(" ").toLowerCase().includes(q);
      })
      .sort((a, b) => sort === "score" ? b.score - a.score : sort === "discount" ? b.discountPct - a.discountPct : b.price - a.price);
  }, [anomalies, filters, sort]);

  const stats = useMemo(() => ({
    total: rows.length,
    flagged: anomalies.length,
    avgDiscount: anomalies.length ? Math.round(anomalies.reduce((a, b) => a + b.discountPct, 0) / anomalies.length) : 0,
    topScore: anomalies[0]?.score || 0,
  }), [rows, anomalies]);

  if (!rows.length) return <UploadZone onData={onData} />;

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.textPrimary, fontFamily: TNR }}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.borderDark}; border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { background: ${C.orange}; }
        input::placeholder { color: ${C.textMuted}; font-family: 'Times New Roman', Times, serif; }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${C.border}`, padding: "14px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0,
        background: "rgba(250,250,248,0.96)", backdropFilter: "blur(12px)", zIndex: 100,
        boxShadow: "0 1px 0 rgba(13,27,42,0.06)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: C.orange, fontSize: 15, fontWeight: 700 }}>⌖</span>
          </div>
          <div>
            <div style={{ fontFamily: TNR, fontSize: 19, fontWeight: 700, color: C.navy, lineHeight: 1 }}>LandSignal</div>
            <div style={{ fontFamily: TNR, fontSize: 10, color: C.textMuted, letterSpacing: 1, marginTop: 2 }}>
              {stats.total.toLocaleString()} transactions · {stats.flagged} flagged
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
          {[
            { label: "Flagged", value: stats.flagged },
            { label: "Avg Discount", value: `${stats.avgDiscount}%` },
            { label: "Top Score", value: `${stats.topScore}/100` },
          ].map(({ label, value }) => (
            <div key={label} style={{ textAlign: "center" }}>
              <div style={{ fontFamily: TNR, fontSize: 20, fontWeight: 700, color: C.orange }}>{value}</div>
              <div style={{ fontFamily: TNR, fontSize: 9, color: C.textMuted, letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
            </div>
          ))}
          <button onClick={() => exportCSV(filtered)} style={{
            background: C.orange, border: "none", color: "#fff",
            borderRadius: 8, padding: "8px 18px",
            fontFamily: TNR, fontSize: 13,
            cursor: "pointer", fontWeight: 700, transition: "background 0.15s"
          }}
            onMouseEnter={e => e.target.style.background = C.orangeLight}
            onMouseLeave={e => e.target.style.background = C.orange}
          >
            ↓ Export CSV
          </button>
          <button onClick={() => { setRows([]); setAnomalies([]); }} style={{
            background: "transparent", border: `1px solid ${C.border}`,
            color: C.textMuted, borderRadius: 8, padding: "8px 14px",
            fontFamily: TNR, fontSize: 13, cursor: "pointer"
          }}>
            New File
          </button>
        </div>
      </div>

      <div style={{ display: "flex", minHeight: "calc(100vh - 57px)" }}>
        {/* Sidebar */}
        <div style={{
          width: 220, flexShrink: 0, borderRight: `1px solid ${C.border}`,
          padding: "24px 16px", position: "sticky", top: 57,
          height: "calc(100vh - 57px)", overflowY: "auto", background: C.bgSidebar
        }}>
          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 2, marginBottom: 16, textTransform: "uppercase" }}>Filters</div>

          <div style={{ fontFamily: TNR, fontSize: 13, color: C.textSecondary, marginBottom: 4 }}>
            Min Score: <strong style={{ color: C.navy }}>{filters.minScore}</strong>
          </div>
          <input type="range" min={0} max={100} value={filters.minScore}
            onChange={e => setFilters(f => ({ ...f, minScore: +e.target.value }))}
            style={{ width: "100%", marginBottom: 20, accentColor: C.orange }} />

          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 1.5, marginBottom: 6, textTransform: "uppercase" }}>Property Type</div>
          {["ALL", "D", "S", "T", "F", "O"].map(t => (
            <FilterBtn key={t} active={filters.type === t} onClick={() => setFilters(f => ({ ...f, type: t }))}>
              {t === "ALL" ? "All types" : PROPERTY_TYPES[t]}
            </FilterBtn>
          ))}

          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 1.5, marginTop: 16, marginBottom: 6, textTransform: "uppercase" }}>Tenure</div>
          {["ALL", "F", "L"].map(t => (
            <FilterBtn key={t} active={filters.tenure === t} onClick={() => setFilters(f => ({ ...f, tenure: t }))}>
              {t === "ALL" ? "All tenure" : TENURE[t]}
            </FilterBtn>
          ))}

          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 1.5, marginTop: 16, marginBottom: 6, textTransform: "uppercase" }}>Sale Category</div>
          {[["ALL", "All categories"], ["A", "Standard Sale"], ["B", "Additional PPD"]].map(([v, l]) => (
            <FilterBtn key={v} active={filters.category === v} onClick={() => setFilters(f => ({ ...f, category: v }))}>{l}</FilterBtn>
          ))}

          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 1.5, marginTop: 16, marginBottom: 6, textTransform: "uppercase" }}>Sort By</div>
          {[["score", "Opportunity Score"], ["discount", "Discount %"], ["price", "Sale Price"]].map(([v, l]) => (
            <FilterBtn key={v} active={sort === v} onClick={() => setSort(v)}>{l}</FilterBtn>
          ))}
        </div>

        {/* Main */}
        <div style={{ flex: 1, padding: "24px 28px", overflowY: "auto" }}>
          <input
            placeholder="Search by postcode, town, street..."
            value={filters.search}
            onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
            style={{
              width: "100%", background: C.bgCard,
              border: `1px solid ${C.border}`, borderRadius: 8,
              padding: "11px 16px", color: C.textPrimary, fontSize: 14,
              fontFamily: TNR, outline: "none",
              marginBottom: 18, boxShadow: "0 1px 3px rgba(13,27,42,0.05)"
            }}
          />

          <div style={{ fontFamily: TNR, fontSize: 11, color: C.textMuted, letterSpacing: 1.5, marginBottom: 14, textTransform: "uppercase" }}>
            {filtered.length} leads · sorted by {sort}
          </div>

          {filtered.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 40px", color: C.textMuted, fontFamily: TNR, fontSize: 15 }}>
              No anomalies match the current filters.
            </div>
          ) : (
            filtered.map(site => (
              <SiteCard
                key={site.id}
                site={site}
                onAnalyse={(id, text) => setNarratives(n => ({ ...n, [id]: text }))}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
