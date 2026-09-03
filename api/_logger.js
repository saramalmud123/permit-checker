/**
 * עוטף כל לוג ומסנן החוצה מפתחות/ערכים שעלולים להכיל מידע אישי (PII).
 *
 * זהו פתרון הגנתי (defense-in-depth), לא הגנה מוחלטת: הוא מגן על כל לוג
 * שעובר דרך הפונקציה הזו, אך אינו יכול למנוע מקוד אחר בפרויקט להדפיס
 * ישירות ל-console.log בעתיד. הכלל המחייב נשאר: בכל קובץ חדש בצד השרת,
 * יש להשתמש אך ורק ב-safeLog ולא ב-console.log/console.error ישירות.
 */

const SENSITIVE_KEYS = new Set([
  "name",
  "fullname",
  "idnumber",
  "id_number",
  "teudatzehut",
  "address",
  "beneficiary",
  "base64",
  "text",
  "content",
  "owners",
  "records",
  "subparcels",
  "cautionnotes",
]);

const MAX_PLAIN_VALUE_LENGTH = 200;

function redactValue(key, value) {
  if (SENSITIVE_KEYS.has(String(key).toLowerCase())) {
    return "[REDACTED]";
  }
  if (typeof value === "string" && value.length > MAX_PLAIN_VALUE_LENGTH) {
    // מחרוזת חריגה באורכה כנראה מכילה תוכן (למשל טקסט שחולץ ממסמך) ולא מטא-דאטה תמימה
    return `[REDACTED:long-string len=${value.length}]`;
  }
  if (value && typeof value === "object") {
    // לא נכנסים לעומק אובייקטים מקוננים - חוסמים כברירת מחדל, בטוח יותר מלהניח שהם נקיים
    return "[REDACTED:object]";
  }
  return value;
}

function sanitize(meta) {
  const cleaned = {};
  for (const [key, value] of Object.entries(meta || {})) {
    cleaned[key] = redactValue(key, value);
  }
  return cleaned;
}

export function safeLog(event, meta = {}) {
  console.log(`[${event}]`, JSON.stringify(sanitize(meta)));
}

export function safeLogError(event, meta = {}) {
  console.error(`[${event}]`, JSON.stringify(sanitize(meta)));
}
