// Request helpers shared by the API functions: input checks, rate limiting, error messages.

const MAX_CHARS = 20_000;
const MIN_CHARS = 50;
const RATE_LIMIT = 10; // requests per IP per minute, per server instance
const hits = new Map();

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

export function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

export function readInput(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const resume = typeof body?.resume === "string" ? body.resume.trim() : "";
  const jobDesc = typeof body?.jobDesc === "string" ? body.jobDesc.trim() : "";
  const mode = ["general", "tech", "fresher", "changer"].includes(body?.mode) ? body.mode : "general";
  const language = body?.language === "hi" ? "hi" : "en";
  const type = typeof body?.type === "string" ? body.type : "";

  if (resume.length < MIN_CHARS || jobDesc.length < MIN_CHARS) {
    return { error: "Please paste the full resume and the full job description (at least 50 characters each)." };
  }
  if (resume.length > MAX_CHARS || jobDesc.length > MAX_CHARS) {
    return { error: `Text is too long. Keep the resume and job description under ${MAX_CHARS.toLocaleString()} characters each.` };
  }
  return { resume, jobDesc, mode, language, type };
}

// Shared checks before calling Gemini. Returns true if a response was already sent.
export function rejectRequest(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Use POST." });
    return true;
  }
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({
      error: "The server has no Gemini API key. Locally, paste it into .env.local and restart `npm run dev`. On Vercel, add GEMINI_API_KEY under Settings → Environment Variables, then redeploy.",
    });
    return true;
  }
  if (rateLimited(clientIp(req))) {
    res.status(429).json({ error: "Too many requests. Please wait a minute and try again." });
    return true;
  }
  return false;
}

export function sendAiError(res, err) {
  if (err.status === 400 && /Unknown (tool|mode)/.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  const status = err.status === 429 ? 429 : 502;
  const message = err.status === 429 || err.status === 503
    ? "The AI is very busy right now. Wait a minute and try again."
    : err.status === 400 || err.status === 403
      ? "The AI service rejected the request. The API key may be invalid or restricted."
      : `The AI service failed: ${err.message}`;
  return res.status(status).json({ error: message });
}
