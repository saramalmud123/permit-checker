import React, { useState, useRef, useCallback } from "react";

/* ============================================================
   מערכת הצלבת נסחי טאבו מול טפסי חתימות/מסירה - היתרי בנייה
   גרסת פריסה: הקריאה למודל השפה מתבצעת דרך /api/extract (שרת),
   לא ישירות מהדפדפן - כך שמפתח ה-API אינו נחשף ללקוח.
   ============================================================ */

const COLORS = {
  bg: "#F3F5F8",
  panel: "#FFFFFF",
  primary: "#1F3A5F",
  primaryDark: "#15263D",
  primarySoft: "#EAF0F7",
  accent: "#B8863B",
  border: "#DDE2E9",
  text: "#1B222C",
  subtext: "#5B6472",
  green: "#1E7A46",
  greenBg: "#E4F5EA",
  greenBorder: "#BEE3CB",
  yellow: "#8A6D1D",
  yellowBg: "#FDF3D6",
  yellowBorder: "#F1DFA0",
  red: "#B3261E",
  redBg: "#FBE8E6",
  redBorder: "#F3C6C1",
};

let uidCounter = 0;
const uid = () => `id_${uidCounter++}_${Math.random().toString(36).slice(2, 7)}`;

/* ---------------- Hebrew name normalization & fuzzy match ---------------- */

function normalizeName(s) {
  if (!s) return "";
  let n = String(s).trim();
  n = n.replace(/[\u0591-\u05C7]/g, ""); // niqqud
  n = n.replace(/["'׳״`]/g, "");
  n = n.replace(/\s+/g, " ");
  const finals = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
  n = n
    .split("")
    .map((ch) => finals[ch] || ch)
    .join("");
  return n.toLowerCase();
}

function levenshtein(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function nameSimilarity(a, b) {
  const na = normalizeName(a),
    nb = normalizeName(b);
  if (!na || !nb) return { match: false };
  if (na === nb) return { match: true, exact: true, dist: 0 };
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  const allowed = maxLen > 8 ? 2 : 1;
  if (dist <= allowed) return { match: true, exact: false, dist };
  return { match: false };
}

function idsMatch(a, b) {
  if (!a || !b) return false;
  const na = String(a).replace(/\D/g, "");
  const nb = String(b).replace(/\D/g, "");
  return na.length >= 5 && na === nb;
}

/* ---------------- File -> base64 ---------------- */

function guessMediaType(file) {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop().toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (["jpg", "jpeg"].includes(ext)) return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "application/octet-stream";
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1];
      resolve({ base64, mediaType: guessMediaType(file) });
    };
    reader.onerror = () => reject(new Error(`כשל בקריאת הקובץ ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/* ---------------- Extraction via our own backend (no key in the browser) ---------------- */

async function extractViaBackend(base64, mediaType, promptType) {
  const res = await fetch("/api/extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, mediaType, promptType }),
  });

  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new Error("תגובה לא תקינה מהשרת");
  }

  if (!res.ok) {
    throw new Error(payload?.error || `שגיאת שרת (${res.status})`);
  }
  return payload.result;
}

/* ---------------- Report generation ---------------- */

function buildReport(subParcels, records) {
  let counts = { green: 0, yellow: 0, red: 0 };

  const groups = subParcels.map((sp) => {
    const ownerResults = sp.owners.map((o) => {
      let rec = null;
      let matchType = null;

      rec = records.find((r) => idsMatch(r.idNumber, o.idNumber));
      if (rec) matchType = "id";

      if (!rec && o.name) {
        rec = records.find((r) => r.name && normalizeName(r.name) === normalizeName(o.name));
        if (rec) matchType = "exact_name";
      }

      if (!rec && o.name) {
        let best = null,
          bestDist = Infinity;
        records.forEach((r) => {
          const sim = nameSimilarity(o.name, r.name);
          if (sim.match && !sim.exact && sim.dist < bestDist) {
            best = r;
            bestDist = sim.dist;
          }
        });
        if (best) {
          rec = best;
          matchType = "fuzzy_name";
        }
      }

      let color, note;
      if (!rec) {
        color = "red";
        note = "לא אותרה חתימה או אישור מסירה התואמים לבעלים זה.";
      } else if (rec.status === "סורב") {
        color = "red";
        note = `אישור מסירה סורב ע"י הנמען (הטופס נקשר ל"${rec.name}") — נדרש טיפול משפטי/פרוצדורלי נוסף.`;
      } else if (rec.status === "לא_נדרש") {
        color = "red";
        note = `המכתב חזר עם ציון "לא נדרש" (הטופס נקשר ל"${rec.name}") — נדרשת בדיקה/מסירה חוזרת.`;
      } else if (rec.status === "לא_ידוע") {
        color = "yellow";
        note = "סטטוס המסירה/החתימה אינו חד־משמעי בטופס — נדרשת בדיקה ידנית.";
      } else if (matchType === "fuzzy_name") {
        color = "yellow";
        note = `הותאם לפי דמיון שמות ("${o.name}" מול "${rec.name}") — ייתכן הבדל כתיב, מומלץ לאמת ידנית.`;
      } else {
        color = "green";
        note = matchType === "id" ? "חתימה/מסירה תקינה, הותאמה לפי מספר זהות." : "חתימה/מסירה תקינה ותואמת.";
      }

      return { ...o, matchedRecord: rec, matchType, color, note };
    });

    const hasInheritance = sp.owners.some((o) => (o.ownershipType || "").includes("ירוש"));
    const requireAll = hasInheritance || sp.owners.length <= 1;

    let groupColor;
    if (requireAll) {
      if (ownerResults.some((o) => o.color === "red")) groupColor = "red";
      else if (ownerResults.some((o) => o.color === "yellow")) groupColor = "yellow";
      else groupColor = "green";
    } else {
      if (ownerResults.some((o) => o.color === "green")) groupColor = "green";
      else if (ownerResults.some((o) => o.color === "yellow")) groupColor = "yellow";
      else groupColor = "red";
    }

    const ruleNote =
      sp.owners.length > 1
        ? hasInheritance
          ? "זוהתה בעלות מסוג ירושה — נדרשת חתימה/מסירה תקינה לכלל היורשים הרשומים."
          : "הוחל כלל בני זוג/בעלות משותפת — די בחתימה או מסירה תקינה של אחד מבעלי הדירה."
        : "";

    const warnings = (sp.cautionNotes || [])
      .filter((c) => c.type !== "משכנתא")
      .map((c) => {
        const rec = records.find((r) => nameSimilarity(r.name, c.beneficiary).match);
        return {
          beneficiary: c.beneficiary,
          resolved: !!rec,
          text: rec
            ? `הערת אזהרה לטובת "${c.beneficiary}" — אותרה התייחסות בטפסים (${rec.name}).`
            : `הערת אזהרה לטובת "${c.beneficiary}" (צד שלישי) — לא אותרה הודעה/חתימה נפרדת בטפסים, נדרש בירור.`,
        };
      });

    if (warnings.some((w) => !w.resolved) && groupColor === "green") groupColor = "yellow";

    counts[groupColor] += 1;

    return { subParcelId: sp.subParcelId || "(ללא מספר)", ownerResults, groupColor, ruleNote, warnings };
  });

  return { groups, counts };
}

function colorLabel(c) {
  return c === "green" ? "תקין" : c === "yellow" ? "לתשומת לב" : "חסר / שגוי";
}

function buildTextReport(report) {
  const lines = [];
  lines.push("סיכום בדיקת התאמת בעלות מול חתימות/מסירות דואר — היתר בנייה");
  lines.push(`תקין: ${report.counts.green}   |   לתשומת לב: ${report.counts.yellow}   |   חסר/שגוי: ${report.counts.red}`);
  lines.push("");
  report.groups.forEach((g) => {
    lines.push(`תת חלקה ${g.subParcelId} — סטטוס כללי: ${colorLabel(g.groupColor)}`);
    if (g.ruleNote) lines.push(`  כלל שהוחל: ${g.ruleNote}`);
    g.ownerResults.forEach((o) => {
      lines.push(`  - ${o.name || "(ללא שם)"} ${o.idNumber ? "(ת.ז. " + o.idNumber + ")" : ""}: ${colorLabel(o.color)} — ${o.note}`);
    });
    g.warnings.forEach((w) => lines.push(`  ⚠ ${w.text}`));
    lines.push("");
  });
  return lines.join("\n");
}

/* ---------------- Small UI atoms ---------------- */

function Badge({ color, children }) {
  const map = {
    green: { bg: COLORS.greenBg, fg: COLORS.green, bd: COLORS.greenBorder },
    yellow: { bg: COLORS.yellowBg, fg: COLORS.yellow, bd: COLORS.yellowBorder },
    red: { bg: COLORS.redBg, fg: COLORS.red, bd: COLORS.redBorder },
  }[color];
  return (
    <span
      style={{
        background: map.bg,
        color: map.fg,
        border: `1px solid ${map.bd}`,
        borderRadius: 999,
        padding: "2px 12px",
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SectionTitle({ eyebrow, title }) {
  return (
    <div style={{ marginBottom: 14 }}>
      {eyebrow && (
        <div style={{ fontSize: 12, letterSpacing: 1, color: COLORS.accent, fontWeight: 700, marginBottom: 4 }}>
          {eyebrow}
        </div>
      )}
      <div style={{ fontSize: 19, fontWeight: 700, color: COLORS.primary }}>{title}</div>
    </div>
  );
}

function FileDrop({ label, hint, files, onFiles, onRemove, accept }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      style={{
        background: COLORS.panel,
        border: `1.5px dashed ${dragOver ? COLORS.primary : COLORS.border}`,
        borderRadius: 12,
        padding: 18,
        flex: 1,
        minWidth: 260,
        transition: "border-color .15s",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div style={{ fontWeight: 700, color: COLORS.text, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: COLORS.subtext, marginBottom: 10 }}>{hint}</div>
      <button
        onClick={() => inputRef.current?.click()}
        style={{
          background: COLORS.primarySoft,
          color: COLORS.primary,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 8,
          padding: "8px 14px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        בחר/י קבצים או גרור/י לכאן
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          onFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      {files.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
          {files.map((f, i) => (
            <li
              key={i}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: COLORS.bg,
                borderRadius: 6,
                padding: "6px 10px",
                fontSize: 13,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              <button
                onClick={() => onRemove(i)}
                style={{ background: "none", border: "none", color: COLORS.red, cursor: "pointer", fontSize: 13, fontWeight: 700 }}
              >
                הסר
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 13,
        boxSizing: "border-box",
        ...(props.style || {}),
      }}
    />
  );
}

function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={onChange}
      style={{
        width: "100%",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 13,
        background: "#fff",
      }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function IconBtn({ onClick, children, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: danger ? COLORS.redBg : COLORS.primarySoft,
        color: danger ? COLORS.red : COLORS.primary,
        border: "none",
        borderRadius: 6,
        padding: "5px 10px",
        fontSize: 12,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

/* ---------------- Main App ---------------- */

export default function App() {
  const [tabuFiles, setTabuFiles] = useState([]);
  const [formFiles, setFormFiles] = useState([]);
  const [subParcels, setSubParcels] = useState([]);
  const [records, setRecords] = useState([]);
  const [step, setStep] = useState("upload"); // upload | review | report
  const [processing, setProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  const addTabuFiles = useCallback((files) => setTabuFiles((p) => [...p, ...files]), []);
  const addFormFiles = useCallback((files) => setFormFiles((p) => [...p, ...files]), []);

  async function handleExtract() {
    setProcessing(true);
    setError(null);
    try {
      const mergedSubParcels = {};
      for (const f of tabuFiles) {
        setStatusMsg(`מחלץ נתונים מנסח: ${f.name}...`);
        const { base64, mediaType } = await fileToBase64(f);
        const data = await extractViaBackend(base64, mediaType, "tabu");
        (data.subParcels || []).forEach((sp) => {
          const key = sp.subParcelId || `לא_ידוע_${Object.keys(mergedSubParcels).length + 1}`;
          if (!mergedSubParcels[key]) mergedSubParcels[key] = { subParcelId: key, owners: [], cautionNotes: [] };
          (sp.owners || []).forEach((o) =>
            mergedSubParcels[key].owners.push({
              id: uid(),
              name: o.name || "",
              idNumber: o.idNumber || "",
              ownershipShare: o.ownershipShare || "",
              ownershipType: o.ownershipType || "רגיל",
            })
          );
          (sp.cautionNotes || []).forEach((c) =>
            mergedSubParcels[key].cautionNotes.push({
              id: uid(),
              beneficiary: c.beneficiary || "",
              type: c.type || "צד_שלישי",
            })
          );
        });
      }

      const mergedRecords = [];
      for (const f of formFiles) {
        setStatusMsg(`מחלץ נתונים מטופס: ${f.name}...`);
        const { base64, mediaType } = await fileToBase64(f);
        const data = await extractViaBackend(base64, mediaType, "form");
        (data.records || []).forEach((r) =>
          mergedRecords.push({
            id: uid(),
            name: r.name || "",
            idNumber: r.idNumber || "",
            address: r.address || "",
            status: r.status || "לא_ידוע",
            sourceFile: f.name,
          })
        );
      }

      setSubParcels(Object.values(mergedSubParcels));
      setRecords(mergedRecords);
      setStep("review");
    } catch (e) {
      setError(e.message || "אירעה שגיאה בעיבוד הקבצים.");
    } finally {
      setProcessing(false);
      setStatusMsg("");
    }
  }

  function generate() {
    setReport(buildReport(subParcels, records));
    setStep("report");
  }

  function resetAll() {
    setTabuFiles([]);
    setFormFiles([]);
    setSubParcels([]);
    setRecords([]);
    setReport(null);
    setError(null);
    setStep("upload");
  }

  const OWNERSHIP_TYPES = ["רגיל", "משותף", "ירושה"];
  const STATUS_OPTIONS = ["חתם", "נמסר", "סורב", "לא_נדרש", "לא_ידוע"];

  return (
    <div dir="rtl" lang="he" style={{ fontFamily: "'Segoe UI', Arial, sans-serif", background: COLORS.bg, minHeight: "100%", color: COLORS.text }}>
      {/* Header */}
      <div style={{ background: COLORS.primary, color: "#fff", padding: "22px 26px" }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>מערכת הצלבת בעלות מול חתימות ומסירות דואר</div>
        <div style={{ fontSize: 13.5, opacity: 0.85, marginTop: 4 }}>
          בדיקת תאימות בין נסח טאבו לבין טפסי הצהרת שכנים ואישורי דואר רשום — לבודקי ועדות תכנון ובנייה
        </div>
      </div>

      <div style={{ maxWidth: 980, margin: "0 auto", padding: "22px 18px 60px" }}>
        {/* Privacy notice */}
        <div
          style={{
            background: COLORS.primarySoft,
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: "10px 14px",
            fontSize: 12.5,
            color: COLORS.subtext,
            marginBottom: 22,
            lineHeight: 1.6,
          }}
        >
          <b style={{ color: COLORS.primary }}>פרטיות:</b> העיבוד מתבצע דרך שרת פנימי ואינו נשמר במסד נתונים של מערכת זו.
          חילוץ הנתונים מהקבצים מבוצע באמצעות קריאה למודל השפה של Anthropic (Claude) שמבוצעת בצד השרת בלבד; יש לוודא
          התאמה למדיניות הפרטיות של הוועדה לפני שימוש בייצור. מומלץ לבדוק ולערוך את הנתונים המחולצים לפני הפקת הדוח הסופי.
        </div>

        {/* Step indicator */}
        <div style={{ display: "flex", gap: 8, marginBottom: 26, fontSize: 13 }}>
          {[
            ["upload", "1. העלאת קבצים"],
            ["review", "2. בדיקה ועריכה"],
            ["report", "3. דוח סיכום"],
          ].map(([key, label]) => (
            <div
              key={key}
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                fontWeight: 700,
                background: step === key ? COLORS.primary : "#fff",
                color: step === key ? "#fff" : COLORS.subtext,
                border: `1px solid ${step === key ? COLORS.primary : COLORS.border}`,
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {error && (
          <div
            style={{
              background: COLORS.redBg,
              border: `1px solid ${COLORS.redBorder}`,
              color: COLORS.red,
              borderRadius: 10,
              padding: "10px 14px",
              marginBottom: 18,
              fontSize: 13.5,
            }}
          >
            {error}
          </div>
        )}

        {/* STEP 1: UPLOAD */}
        {step === "upload" && (
          <div>
            <SectionTitle eyebrow="שלב א׳" title="העלאת מסמכים" />
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <FileDrop
                label="נסח/י טאבו"
                hint="קובצי PDF דיגיטליים מקוריים מהאתר הממשלתי"
                files={tabuFiles}
                onFiles={addTabuFiles}
                onRemove={(i) => setTabuFiles((p) => p.filter((_, idx) => idx !== i))}
                accept=".pdf,image/*"
              />
              <FileDrop
                label="טפסי חתימות / אישורי מסירת דואר"
                hint="טפסי הצהרת שכנים, שוברי דואר רשום (מודפס/כתב יד), אישורי מכתב דיגיטלי"
                files={formFiles}
                onFiles={addFormFiles}
                onRemove={(i) => setFormFiles((p) => p.filter((_, idx) => idx !== i))}
                accept=".pdf,image/*"
              />
            </div>

            <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 14 }}>
              <button
                disabled={processing || (tabuFiles.length === 0 && formFiles.length === 0)}
                onClick={handleExtract}
                style={{
                  background: processing ? COLORS.subtext : COLORS.primary,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "11px 22px",
                  fontSize: 14.5,
                  fontWeight: 700,
                  cursor: processing ? "default" : "pointer",
                  opacity: tabuFiles.length === 0 && formFiles.length === 0 ? 0.5 : 1,
                }}
              >
                {processing ? "מעבד..." : "חלץ נתונים מהקבצים"}
              </button>
              {processing && <span style={{ fontSize: 13, color: COLORS.subtext }}>{statusMsg}</span>}
            </div>
          </div>
        )}

        {/* STEP 2: REVIEW */}
        {step === "review" && (
          <div>
            <SectionTitle eyebrow="שלב ב׳" title="בדיקה ועריכת הנתונים שחולצו" />

            {subParcels.map((sp, spi) => (
              <div
                key={sp.subParcelId + spi}
                style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700 }}>
                    תת חלקה:{" "}
                    <input
                      value={sp.subParcelId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSubParcels((prev) => prev.map((s, i) => (i === spi ? { ...s, subParcelId: v } : s)));
                      }}
                      style={{ border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: "4px 8px", width: 140, fontSize: 13 }}
                    />
                  </div>
                  <IconBtn
                    danger
                    onClick={() => setSubParcels((prev) => prev.filter((_, i) => i !== spi))}
                  >
                    הסר תת חלקה
                  </IconBtn>
                </div>

                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: COLORS.subtext, textAlign: "right" }}>
                      <th style={{ padding: 4 }}>שם בעלים</th>
                      <th style={{ padding: 4 }}>ת.ז.</th>
                      <th style={{ padding: 4 }}>חלק בבעלות</th>
                      <th style={{ padding: 4 }}>סוג בעלות</th>
                      <th style={{ padding: 4 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sp.owners.map((o, oi) => (
                      <tr key={o.id}>
                        <td style={{ padding: 4 }}>
                          <TextInput
                            value={o.name}
                            onChange={(e) =>
                              setSubParcels((prev) =>
                                prev.map((s, i) =>
                                  i === spi ? { ...s, owners: s.owners.map((ow, j) => (j === oi ? { ...ow, name: e.target.value } : ow)) } : s
                                )
                              )
                            }
                          />
                        </td>
                        <td style={{ padding: 4 }}>
                          <TextInput
                            value={o.idNumber}
                            onChange={(e) =>
                              setSubParcels((prev) =>
                                prev.map((s, i) =>
                                  i === spi ? { ...s, owners: s.owners.map((ow, j) => (j === oi ? { ...ow, idNumber: e.target.value } : ow)) } : s
                                )
                              )
                            }
                          />
                        </td>
                        <td style={{ padding: 4 }}>
                          <TextInput
                            value={o.ownershipShare}
                            onChange={(e) =>
                              setSubParcels((prev) =>
                                prev.map((s, i) =>
                                  i === spi
                                    ? { ...s, owners: s.owners.map((ow, j) => (j === oi ? { ...ow, ownershipShare: e.target.value } : ow)) }
                                    : s
                                )
                              )
                            }
                          />
                        </td>
                        <td style={{ padding: 4 }}>
                          <Select
                            value={o.ownershipType}
                            options={OWNERSHIP_TYPES}
                            onChange={(e) =>
                              setSubParcels((prev) =>
                                prev.map((s, i) =>
                                  i === spi
                                    ? { ...s, owners: s.owners.map((ow, j) => (j === oi ? { ...ow, ownershipType: e.target.value } : ow)) }
                                    : s
                                )
                              )
                            }
                          />
                        </td>
                        <td style={{ padding: 4 }}>
                          <IconBtn
                            danger
                            onClick={() =>
                              setSubParcels((prev) => prev.map((s, i) => (i === spi ? { ...s, owners: s.owners.filter((_, j) => j !== oi) } : s)))
                            }
                          >
                            הסר
                          </IconBtn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  onClick={() =>
                    setSubParcels((prev) =>
                      prev.map((s, i) =>
                        i === spi
                          ? { ...s, owners: [...s.owners, { id: uid(), name: "", idNumber: "", ownershipShare: "", ownershipType: "רגיל" }] }
                          : s
                      )
                    )
                  }
                  style={{ marginTop: 8, background: "none", border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: COLORS.primary }}
                >
                  + הוסף בעלים
                </button>

                {/* caution notes */}
                <div style={{ marginTop: 12, borderTop: `1px solid ${COLORS.border}`, paddingTop: 10 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: COLORS.subtext, marginBottom: 6 }}>הערות אזהרה</div>
                  {(sp.cautionNotes || []).map((c, ci) => (
                    <div key={c.id} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                      <div style={{ flex: 2 }}>
                        <TextInput
                          placeholder="שם הגורם לטובתו נרשמה ההערה"
                          value={c.beneficiary}
                          onChange={(e) =>
                            setSubParcels((prev) =>
                              prev.map((s, i) =>
                                i === spi
                                  ? { ...s, cautionNotes: s.cautionNotes.map((cn, j) => (j === ci ? { ...cn, beneficiary: e.target.value } : cn)) }
                                  : s
                              )
                            )
                          }
                        />
                      </div>
                      <div style={{ flex: 1 }}>
                        <Select
                          value={c.type}
                          options={["משכנתא", "צד_שלישי"]}
                          onChange={(e) =>
                            setSubParcels((prev) =>
                              prev.map((s, i) =>
                                i === spi ? { ...s, cautionNotes: s.cautionNotes.map((cn, j) => (j === ci ? { ...cn, type: e.target.value } : cn)) } : s
                              )
                            )
                          }
                        />
                      </div>
                      <IconBtn
                        danger
                        onClick={() =>
                          setSubParcels((prev) =>
                            prev.map((s, i) => (i === spi ? { ...s, cautionNotes: s.cautionNotes.filter((_, j) => j !== ci) } : s))
                          )
                        }
                      >
                        הסר
                      </IconBtn>
                    </div>
                  ))}
                  <button
                    onClick={() =>
                      setSubParcels((prev) =>
                        prev.map((s, i) => (i === spi ? { ...s, cautionNotes: [...s.cautionNotes, { id: uid(), beneficiary: "", type: "צד_שלישי" }] } : s))
                      )
                    }
                    style={{ background: "none", border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: COLORS.primary }}
                  >
                    + הוסף הערת אזהרה
                  </button>
                </div>
              </div>
            ))}

            <button
              onClick={() => setSubParcels((prev) => [...prev, { subParcelId: "", owners: [], cautionNotes: [] }])}
              style={{ background: COLORS.primarySoft, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: COLORS.primary, marginBottom: 26 }}
            >
              + הוסף תת חלקה
            </button>

            <SectionTitle title="רשומות חתימה / מסירת דואר" />
            <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: COLORS.subtext, textAlign: "right" }}>
                    <th style={{ padding: 4 }}>שם</th>
                    <th style={{ padding: 4 }}>ת.ז.</th>
                    <th style={{ padding: 4 }}>כתובת</th>
                    <th style={{ padding: 4 }}>סטטוס</th>
                    <th style={{ padding: 4 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, ri) => (
                    <tr key={r.id}>
                      <td style={{ padding: 4 }}>
                        <TextInput value={r.name} onChange={(e) => setRecords((prev) => prev.map((x, i) => (i === ri ? { ...x, name: e.target.value } : x)))} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <TextInput value={r.idNumber} onChange={(e) => setRecords((prev) => prev.map((x, i) => (i === ri ? { ...x, idNumber: e.target.value } : x)))} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <TextInput value={r.address} onChange={(e) => setRecords((prev) => prev.map((x, i) => (i === ri ? { ...x, address: e.target.value } : x)))} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <Select value={r.status} options={STATUS_OPTIONS} onChange={(e) => setRecords((prev) => prev.map((x, i) => (i === ri ? { ...x, status: e.target.value } : x)))} />
                      </td>
                      <td style={{ padding: 4 }}>
                        <IconBtn danger onClick={() => setRecords((prev) => prev.filter((_, i) => i !== ri))}>
                          הסר
                        </IconBtn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                onClick={() => setRecords((prev) => [...prev, { id: uid(), name: "", idNumber: "", address: "", status: "לא_ידוע" }])}
                style={{ marginTop: 8, background: "none", border: `1px dashed ${COLORS.border}`, borderRadius: 6, padding: "5px 10px", fontSize: 12, cursor: "pointer", color: COLORS.primary }}
              >
                + הוסף רשומה
              </button>
            </div>

            <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
              <button
                onClick={generate}
                style={{ background: COLORS.primary, color: "#fff", border: "none", borderRadius: 8, padding: "11px 22px", fontSize: 14.5, fontWeight: 700, cursor: "pointer" }}
              >
                הפק דוח הצלבה
              </button>
              <button
                onClick={() => setStep("upload")}
                style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "11px 22px", fontSize: 14.5, fontWeight: 600, cursor: "pointer", color: COLORS.subtext }}
              >
                חזרה להעלאת קבצים
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: REPORT */}
        {step === "report" && report && (
          <div>
            <SectionTitle eyebrow="שלב ג׳" title="דוח סיכום לבודק ההיתר" />

            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              {[
                ["green", "תקין", report.counts.green],
                ["yellow", "לתשומת לב", report.counts.yellow],
                ["red", "חסר / שגוי", report.counts.red],
              ].map(([c, label, n]) => (
                <div
                  key={c}
                  style={{
                    flex: 1,
                    minWidth: 140,
                    background: { green: COLORS.greenBg, yellow: COLORS.yellowBg, red: COLORS.redBg }[c],
                    border: `1px solid ${{ green: COLORS.greenBorder, yellow: COLORS.yellowBorder, red: COLORS.redBorder }[c]}`,
                    borderRadius: 10,
                    padding: 14,
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 26, fontWeight: 800, color: { green: COLORS.green, yellow: COLORS.yellow, red: COLORS.red }[c] }}>{n}</div>
                  <div style={{ fontSize: 13, color: COLORS.subtext, fontWeight: 600 }}>{label}</div>
                </div>
              ))}
            </div>

            {report.groups.map((g, gi) => (
              <div
                key={gi}
                style={{
                  background: COLORS.panel,
                  borderRadius: 10,
                  border: `1px solid ${COLORS.border}`,
                  borderInlineStart: `5px solid ${{ green: COLORS.green, yellow: COLORS.yellow, red: COLORS.red }[g.groupColor]}`,
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>תת חלקה {g.subParcelId}</div>
                  <Badge color={g.groupColor}>{colorLabel(g.groupColor)}</Badge>
                </div>
                {g.ruleNote && <div style={{ fontSize: 12.5, color: COLORS.subtext, marginBottom: 10 }}>{g.ruleNote}</div>}

                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {g.ownerResults.map((o, oi) => (
                    <div key={oi} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, background: COLORS.bg, borderRadius: 8, padding: "8px 12px" }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 13.5 }}>
                          {o.name || "(ללא שם)"} {o.idNumber && <span style={{ color: COLORS.subtext, fontWeight: 400 }}>· ת.ז. {o.idNumber}</span>}
                        </div>
                        <div style={{ fontSize: 12.5, color: COLORS.subtext, marginTop: 2 }}>{o.note}</div>
                      </div>
                      <Badge color={o.color}>{colorLabel(o.color)}</Badge>
                    </div>
                  ))}
                </div>

                {g.warnings.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {g.warnings.map((w, wi) => (
                      <div key={wi} style={{ fontSize: 12.5, color: w.resolved ? COLORS.subtext : COLORS.red }}>
                        ⚠ {w.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            <SectionTitle title="טקסט מרוכז להעתקה" />
            <ReportText report={report} />

            <div style={{ marginTop: 20 }}>
              <button
                onClick={() => setStep("review")}
                style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "11px 22px", fontSize: 14.5, fontWeight: 600, cursor: "pointer", color: COLORS.subtext, marginInlineEnd: 10 }}
              >
                חזרה לעריכה
              </button>
              <button
                onClick={resetAll}
                style={{ background: "none", border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "11px 22px", fontSize: 14.5, fontWeight: 600, cursor: "pointer", color: COLORS.subtext }}
              >
                בדיקה חדשה
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ReportText({ report }) {
  const [copied, setCopied] = useState(false);
  const text = buildTextReport(report);
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 14 }}>
      <textarea
        readOnly
        value={text}
        style={{ width: "100%", minHeight: 220, border: "none", resize: "vertical", fontFamily: "monospace", fontSize: 12.5, boxSizing: "border-box", background: "transparent" }}
      />
      <button
        onClick={() => {
          navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        style={{ marginTop: 8, background: COLORS.primary, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
      >
        {copied ? "הועתק!" : "העתק דוח"}
      </button>
    </div>
  );
}
