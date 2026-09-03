import { TABU_PROMPT, FORM_PROMPT } from "./_prompts.js";
import { safeLog, safeLogError } from "./_logger.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "Method not allowed" });
  }

  const { base64, mediaType, promptType } = request.body || {};

  if (!base64 || !mediaType || !promptType) {
    return response.status(400).json({ error: "חסרים שדות בבקשה (base64 / mediaType / promptType)" });
  }

  const promptText = promptType === "tabu" ? TABU_PROMPT : promptType === "form" ? FORM_PROMPT : null;
  if (!promptText) {
    return response.status(400).json({ error: "סוג פרומפט לא תקין" });
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
        max_tokens: 4096,
        messages: [{ role: "user", content: [contentBlock, { type: "text", text: promptText }] }],
      }),
    });

    safeLog("extract_request", { promptType, upstreamStatus: anthropicResponse.status });

    if (!anthropicResponse.ok) {
      let detail = "";
      try {
        const errBody = await anthropicResponse.json();
        detail = errBody?.error?.message || "";
      } catch (e) {}
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
    safeLogError("extract_error", { reason: "internal_exception", errorName: err?.name || "Unknown" });
    return response.status(500).json({ error: "שגיאה פנימית בעיבוד הבקשה" });
  }
}

export const config = {
  api: {
    bodyParser: { sizeLimit: "15mb" },
  },
};
