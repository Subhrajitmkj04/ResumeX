// Vercel serverless function: POST /api/generate
// Extra AI tools after an analysis: type "cover_letter" or "interview".
import { generateExtra } from "../lib/gemini.js";
import { readInput, rejectRequest, sendAiError } from "../lib/http.js";

export default async function handler(req, res) {
  if (rejectRequest(req, res)) return;

  const input = readInput(req);
  if (input.error) return res.status(400).json({ error: input.error });
  if (!["cover_letter", "interview"].includes(input.type)) {
    return res.status(400).json({ error: 'type must be "cover_letter" or "interview".' });
  }

  try {
    const out = await generateExtra({ ...input, apiKey: process.env.GEMINI_API_KEY });
    return res.status(200).json({ type: out.type, result: out.result, model: out.model });
  } catch (err) {
    return sendAiError(res, err);
  }
}
