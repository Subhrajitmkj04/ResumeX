// Calls the Gemini API and cleans up its answer. Shared by the Vercel
// functions (api/*.js) and the evaluation script (tests/run-eval.mjs).
import {
  PROMPTS, CURRENT_VERSION, RESPONSE_SCHEMA, MODES,
  EXTRA_PROMPTS, EXTRA_SCHEMAS, languageRule,
} from "./prompts.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Tried in order; the next model is used if one is busy, missing or slow.
const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash"];

// Errors worth retrying on the next model: model missing, rate-limited, or overloaded.
const RETRYABLE_STATUS = new Set([404, 429, 500, 503]);

// Vercel stops the function at 60 s, so all model attempts share one budget.
const TOTAL_BUDGET_MS = 52_000;
const PER_CALL_MS = 25_000;

export class GeminiError extends Error {
  constructor(message, status, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function modelList() {
  const fromEnv = (process.env.GEMINI_MODELS || "").split(",").map((m) => m.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

async function callGemini(model, { systemText, userText, schema, temperature }, apiKey, timeoutMs) {
  let response;
  try {
    response = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new GeminiError(`Could not reach Gemini (${err.name === "TimeoutError" ? "timed out" : err.message})`, 504, true);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.error?.message || `Gemini API error ${response.status}`;
    throw new GeminiError(message, response.status, RETRYABLE_STATUS.has(response.status));
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "unknown";
    throw new GeminiError(`Gemini returned an empty answer (reason: ${reason})`, 502, true);
  }
  return parseJson(text);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Fallback in case the model wraps the JSON in markdown fences.
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    throw new GeminiError("Gemini did not return valid JSON", 502, true);
  }
}

// Try each model in turn until one answers, within the shared time budget.
async function runWithFallback(request, apiKey) {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError;
  for (const model of modelList()) {
    const remaining = deadline - Date.now();
    if (remaining < 8_000) break;
    try {
      const raw = await callGemini(model, request, apiKey, Math.min(PER_CALL_MS, remaining));
      return { model, raw };
    } catch (err) {
      lastError = err;
      if (!err.retryable) break;
    }
  }
  throw lastError || new GeminiError("No model could answer in time", 504);
}

// Lowercase and strip punctuation so "Node.js," and "node.js" compare equal.
export function normalize(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").replace(/\.(\s|$)/g, " ").replace(/\s+/g, " ").trim()} `;
}

export function appearsIn(keyword, text) {
  const kw = normalize(keyword).trim();
  return kw.length > 0 && normalize(text).includes(` ${kw} `);
}

const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
const strings = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()) : []);
const str = (s) => (typeof s === "string" ? s.trim() : "");
// Resume lines often keep their bullet marker ("- ", "• "); drop it for display.
const unbullet = (s) => str(s).replace(/^[-–•*·]\s+/, "");

// Guardrail: fix ranges and drop "missing" keywords that are actually in the resume.
export function cleanAnalysis(raw, resume) {
  const breakdown = raw.score_breakdown || {};
  const keywords = [...new Set(strings(raw.missing_keywords))];
  const falseMissing = keywords.filter((k) => appearsIn(k, resume));

  return {
    ats_score: clampScore(raw.ats_score),
    score_breakdown: {
      skills: clampScore(breakdown.skills),
      experience: clampScore(breakdown.experience),
      keywords: clampScore(breakdown.keywords),
      presentation: clampScore(breakdown.presentation),
    },
    summary: str(raw.summary),
    strengths: strings(raw.strengths),
    missing_keywords: keywords.filter((k) => !falseMissing.includes(k)),
    skill_gaps: (Array.isArray(raw.skill_gaps) ? raw.skill_gaps : [])
      .filter((g) => g && str(g.skill))
      .map((g) => ({
        skill: str(g.skill),
        priority: g.priority === "must-have" ? "must-have" : "nice-to-have",
        how_to_close: str(g.how_to_close),
      })),
    improvements: strings(raw.improvements),
    bullet_rewrites: (Array.isArray(raw.bullet_rewrites) ? raw.bullet_rewrites : [])
      .filter((b) => b && str(b.original) && str(b.improved))
      .map((b) => ({ original: unbullet(b.original), improved: unbullet(b.improved) })),
    guardrail_removed: falseMissing,
  };
}

function cleanExtra(type, raw) {
  if (type === "cover_letter") {
    return { subject: str(raw.subject), body: str(raw.body) };
  }
  const categories = new Set(["technical", "gap", "project", "behavioral"]);
  return {
    questions: (Array.isArray(raw.questions) ? raw.questions : [])
      .filter((q) => q && str(q.question))
      .map((q) => ({
        question: str(q.question),
        category: categories.has(q.category) ? q.category : "technical",
        why_asked: str(q.why_asked),
        how_to_answer: str(q.how_to_answer),
      })),
  };
}

const userBlock = (resume, jobDesc) => `<resume>\n${resume}\n</resume>\n\n<job_description>\n${jobDesc}\n</job_description>`;

export async function analyzeResume({ resume, jobDesc, mode, language = "en", apiKey, version = CURRENT_VERSION }) {
  const prompt = PROMPTS[version];
  if (!prompt) throw new GeminiError(`Unknown prompt version "${version}"`, 400);
  if (!MODES[mode]) throw new GeminiError(`Unknown mode "${mode}"`, 400);

  const { model, raw } = await runWithFallback({
    systemText: prompt.system(mode) + languageRule(language),
    userText: prompt.user(resume, jobDesc),
    schema: RESPONSE_SCHEMA,
    temperature: 0.2,
  }, apiKey);
  return { model, version, mode, language, raw, analysis: cleanAnalysis(raw, resume) };
}

export async function generateExtra({ type, resume, jobDesc, mode, language = "en", apiKey }) {
  if (!EXTRA_PROMPTS[type]) throw new GeminiError(`Unknown tool "${type}"`, 400);
  if (!MODES[mode]) throw new GeminiError(`Unknown mode "${mode}"`, 400);

  const { model, raw } = await runWithFallback({
    systemText: EXTRA_PROMPTS[type](mode) + languageRule(language),
    userText: userBlock(resume, jobDesc),
    schema: EXTRA_SCHEMAS[type],
    temperature: 0.5,
  }, apiKey);
  return { model, type, result: cleanExtra(type, raw) };
}
