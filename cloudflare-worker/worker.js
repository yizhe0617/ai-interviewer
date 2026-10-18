// AI 面試官｜Cloudflare Worker 中繼站
// 把 Gemini 金鑰藏在 Cloudflare 的設定裡，網頁只呼叫這個中繼站，看不到金鑰。
//
// 需要在 Cloudflare 設定的變數：
//   GEMINI_API_KEY   (Secret，必填) 你的 Gemini API 金鑰
//   ALLOWED_ORIGINS  (選填) 允許呼叫的網址，用逗號分隔，例如：
//                    https://你的帳號.github.io,null
//                    （null 代表直接雙擊開啟的本機檔案；不設定則全部允許）
//   GEMINI_MODEL     (選填) 預設 gemini-2.5-flash

const MAX_BODY = 60000;     // 單次請求最多約 6 萬字元
const MAX_MESSAGES = 40;    // 對話最多 40 則

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    const originOk = !allowed.length || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": originOk ? (origin || "*") : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return reply({ ok: true, service: "ai-interviewer-relay" });
    if (request.method !== "POST") return reply({ error: "只接受 POST" }, 405);
    if (!originOk) return reply({ error: "這個網址沒有權限使用中繼站" }, 403);
    if (!env.GEMINI_API_KEY) return reply({ error: "中繼站尚未設定 GEMINI_API_KEY" }, 500);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply({ error: "資料太長，請縮短上傳的內容" }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return reply({ error: "格式錯誤" }, 400); }
    const { system = "", messages = [], json = false } = body;
    if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGES) return reply({ error: "對話格式錯誤" }, 400);

    const model = env.GEMINI_MODEL || "gemini-2.5-flash";
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: String(system) }] },
        contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "") }] })),
        generationConfig: { temperature: 0.8, ...(json ? { responseMimeType: "application/json" } : {}) },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return reply({ error: data.error?.message || `Gemini 錯誤 ${res.status}` }, res.status === 429 ? 429 : 502);
    const text = (data.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
    return reply({ text });
  },
};
