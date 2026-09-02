import { next } from "@vercel/edge";

/**
 * הגנת גישה בסיסית (Basic Auth) על כל המערכת - גם על דף האתר וגם על ה-API.
 * מיועד כשכבת הגנה מינימלית לפיילוט/שימוש פנימי. עבור שימוש בייצור עם
 * נתוני תושבים אמיתיים, מומלץ להחליף בהתחברות ארגונית (SSO / חשבון עובד).
 *
 * הגדרת המשתמש/סיסמה נעשית אך ורק דרך משתני סביבה בלוח הבקרה של Vercel:
 * BASIC_AUTH_USER, BASIC_AUTH_PASS.
 * לעולם אין להגדיר אותם עם קידומת VITE_ - קידומת כזו הייתה חושפת אותם
 * לדפדפן (לכל קוד הלקוח), בעוד שכאן, ב-middleware, הם נשארים בצד השרת.
 */
export default function middleware(request) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;

  // אם לא הוגדרו פרטי הרשאה בסביבה - חוסמים גישה לחלוטין במקום להשאיר פתוח בטעות
  if (!expectedUser || !expectedPass) {
    return new Response("המערכת אינה מוגדרת כראוי (חסרה הגדרת הרשאת גישה)", { status: 500 });
  }

  const authHeader = request.headers.get("authorization");

  if (authHeader && authHeader.startsWith("Basic ")) {
    const encoded = authHeader.slice(6);
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch (e) {
      decoded = "";
    }
    const sepIndex = decoded.indexOf(":");
    const user = sepIndex >= 0 ? decoded.slice(0, sepIndex) : "";
    const pass = sepIndex >= 0 ? decoded.slice(sepIndex + 1) : "";

    if (user === expectedUser && pass === expectedPass) {
      return next();
    }
  }

  return new Response("נדרשת הזדהות לצורך גישה למערכת", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="permit-checker"' },
  });
}

export const config = {
  matcher: "/:path*",
};
