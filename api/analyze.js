// Vercel serverless function: POST /api/analyze
// The Gemini key lives only here (process.env.GEMINI_API_KEY), never in the browser.
import { analyzeResume } from "../lib/gemini.js";
import { readInput, rejectRequest, sendAiError } from "../lib/http.js";

export default async function handler(req, res) {
  if (rejectRequest(req, res)) return;

  const input = readInput(req);
  if (input.error) return res.status(400).json({ error: input.error });

  try {
    const result = await analyzeResume({ ...input, apiKey: process.env.GEMINI_API_KEY });
    return res.status(200).json({
      analysis: result.analysis,
      model: result.model,
      version: result.version,
      mode: result.mode,
      language: result.language,
    });
  } catch (err) {
    return sendAiError(res, err);
  }
}
