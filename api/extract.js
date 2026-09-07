import { TABU_PROMPT, FORM_PROMPT } from "./_prompts.js";
import { safeLog, safeLogError } from "./_logger.js";

/**
 * נקודת קצה: POST /api/extract
 * body: { base64: string, mediaType: string, promptType: 'tabu' | 'form' }
 *
 * הערות אבטחה:
 * - מפתח ה-API (ANTHROPIC_API_KEY) נקרא אך ורק כאן, בצד השרת, מתוך משתני
 *   הסביבה של Vercel. הוא לעולם לא נשלח ללקוח ולא נמצא בקוד ה-React.
 * - אין להדפיס ל-console תוכן קבצים, שמות, מספרי זהות או כתובות. הלוגים
 *   כאן כוללים אך ורק מטא-דאטה כללית (סוג הבקשה, קוד סטטוס), בהתאם לעקרון
 *   ה-"Stateless" של המערכת - שום מידע אישי לא אמור להישמר בלוגים.
 * - הגישה לנתיב הזה כבר מוגנת ע"י middleware.js (Basic Auth) ברמת הפרויקט,
 *   אבל אין להסתמך על שכבה אחת בלבד לאורך זמן - זה פתרון מינימלי לפיילוט.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { base64, mediaType, promptType, knownNames } = request.body || {};

  if (!base64 || !mediaType || !promptType) {
    return response.status(400).json({ error: "חסרים שדות בבקשה (base64 / mediaType / promptType)" });
  }

  let promptText = promptType === "tabu" ? TABU_PROMPT : promptType === "form" ? FORM_PROMPT : null;
  if (!promptText) {
    return response.status(400).json({ error: "סוג פרומפט לא תקין" });
  }

  // עבור טפסים בלבד: אם יש לנו כבר רשימת שמות בעלים ידועה מהנסח, נעביר אותה כרמז
  // לעזרה בפענוח כתב יד מקוצר/לא ברור - בלי לכפות התאמה שאין לה בסיס סביר.
  if (promptType === "form" && Array.isArray(knownNames) && knownNames.length > 0) {
    const cleanNames = knownNames.filter((n) => typeof n === "string" && n.trim()).slice(0, 200);
    if (cleanNames.length > 0) {
      promptText += `\n\nרשימת שמות בעלי הזכויות הידועים בנכס (מתוך נסח הטאבו שכבר עובד): ${cleanNames.join(", ")}.
אם שם שכתוב בטופס בכתב יד מקוצר/לא ברור נראה קרוב באופן סביר לאחד השמות ברשימה זו, העדף את השם המדויק מהרשימה. אל תכפה התאמה אם אין דמיון סביר - במקרה כזה החזר את מיטב קריאתך.`;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    safeLogError("extract_config_error", { reason: "missing_api_key" });
    return response.status(500).json({ error: "המערכת אינה מוגדרת כראוי (מפתח API חסר בצד השרת)" });
  }

  try {
    const isPdf = mediaType === "application/pdf";
    const contentBlock = isPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: promptText }] }],
      }),
    });

    safeLog("extract_request", { promptType, upstreamStatus: anthropicResponse.status });

    if (!anthropicResponse.ok) {
      // הודעת השגיאה כאן מתארת בעיה בפורמט הבקשה מול Anthropic (למשל סוג קובץ
      // לא נתמך) - היא אינה מכילה תוכן מהקובץ שהמשתמש העלה, ולכן בטוחה ללוג ולתצוגה.
      let detail = "";
      try {
        const errBody = await anthropicResponse.json();
        detail = errBody?.error?.message || "";
      } catch (e) {
        // אין גוף JSON תקין בתגובת השגיאה - נמשיך בלי פרטים נוספים
      }
      safeLogError("extract_upstream_error", { upstreamStatus: anthropicResponse.status, detail });
      return response.status(502).json({
        error: `שגיאה מול שירות החילוץ (קוד ${anthropicResponse.status})${detail ? " — " + detail : ""}`,
      });
    }

    const data = await anthropicResponse.json();
    const text = (data.content || [])
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n");

    // ניקוי גדרות Markdown (```json ... ```) ואיתור גוף ה-JSON גם אם המודל
    // הוסיף בטעות טקסט לפני/אחרי - מחפשים את הסוגריים המסולסלים הראשונים והאחרונים.
    let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // לא מדפיסים את התוכן עצמו (הוא עלול לכלול את הנתונים האישיים שחולצו!) -
      // רק מידע מבני שעוזר לאבחן אם מדובר בקטיעה (truncation) בגלל תקציב פלט נמוך מדי.
      safeLogError("extract_error", {
        reason: "json_parse_failed",
        promptType,
        textLength: cleaned.length,
        endsWithClosingBrace: cleaned.trim().endsWith("}"),
      });
      return response.status(502).json({ error: "לא ניתן היה לפענח את תגובת מנוע החילוץ - ייתכן שהמסמך גדול/עמוס מדי" });
    }

    return response.status(200).json({ result: parsed });
  } catch (err) {
    // בכוונה לא מעבירים את err המלא ל-log - הוא עלול להכיל טקסט שמקורו בקלט המשתמש.
    // רק שם השגיאה (err.name) מועבר, לא ההודעה (err.message) ולא ה-stack.
    safeLogError("extract_error", { reason: "internal_exception", errorName: err?.name || "Unknown" });
    return response.status(500).json({ error: "שגיאה פנימית בעיבוד הבקשה" });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "15mb" },
  },
};
