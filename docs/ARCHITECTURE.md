# Resumex — Architecture and Data Flow

This document describes how data moves through Resumex, using data flow diagrams (DFDs) at three levels, then the data stores, trust boundaries and message formats.

**Notation used in the diagrams**

| Shape | Meaning |
|---|---|
| Rectangle | External entity: a person or system outside Resumex |
| Rounded box | Process: something Resumex does to data |
| Cylinder | Data store: where data is kept |
| Labelled arrow | Data flow |
| Shaded box | Trust boundary |

---

## Level 0 — Context diagram

The whole system as one process, with everything it talks to.

```mermaid
flowchart LR
    U["Job seeker<br/>(browser)"]
    G["Google Gemini API"]
    C["cdnjs<br/>(pdf.js library)"]
    R(["0.0<br/>Resumex"])

    U -- "resume text or PDF,<br/>job description,<br/>reviewer, language" --> R
    R -- "review report, charts,<br/>cover letter, interview questions" --> U
    R -- "prompt + resume + job<br/>(JSON schema request)" --> G
    G -- "structured JSON answer" --> R
    C -- "pdf.js script<br/>(only when a PDF is uploaded)" --> R
```

---

## Level 1 — Main processes

The same pipeline serves both endpoints: `/api/analyze` for the review, and `/api/generate` for the cover letter and interview prep.

```mermaid
flowchart LR
    U["Job seeker"]
    CDN["cdnjs<br/>(pdf.js)"]
    G["Google<br/>Gemini API"]

    subgraph BROWSER["Browser"]
        P1(["1.0 Capture input<br/>paste or read PDF/TXT"])
        P6(["6.0 Render report<br/>escape HTML, ring,<br/>radar, trend chart"])
        P7(["7.0 Manage history"])
        D1[("D1 localStorage<br/>history, theme, language")]
    end

    subgraph SERVER["Vercel serverless functions"]
        P2(["2.0 Validate<br/>method, length, mode,<br/>rate limit"])
        P3(["3.0 Build prompt<br/>review, cover letter<br/>or interview"])
        P4(["4.0 Call Gemini<br/>with model fallback"])
        P5(["5.0 Guardrails<br/>clamp scores,<br/>fix keywords"])
        D2[("D2 GEMINI_API_KEY")]
        D3[("D3 Prompt library<br/>v1, v2, schemas")]
    end

    U -- "resume, job,<br/>reviewer, language" --> P1
    CDN -- "pdf.js" --> P1
    P1 -- "POST /api/analyze" --> P2
    P6 -- "POST /api/generate" --> P2
    P2 -- "valid input" --> P3
    D3 -- "role, rubric, schema" --> P3
    P3 -- "system + user message" --> P4
    D2 -- "API key" --> P4
    P4 -- "request" --> G
    G -- "JSON answer" --> P4
    P4 -- "raw JSON" --> P5
    P5 -- "clean result" --> P6
    P6 -- "report, letter,<br/>questions" --> U
    P6 -- "result, no resume text" --> P7
    P7 <-->|"entries"| D1
```

Validation errors from 2.0 (`400`, `429`) and AI failures from 4.0 go straight back to 6.0, which shows them as a friendly message.

| Process | Where it runs | Code |
|---|---|---|
| 1.0 Capture input | Browser | `app.js` → `handleFile`, `pdfToText` |
| 2.0 Validate | Server | `lib/http.js` → `rejectRequest`, `readInput` |
| 3.0 Build prompt | Server | `lib/prompts.js` → `PROMPTS`, `EXTRA_PROMPTS`, `MODES`, `languageRule` |
| 4.0 Call Gemini | Server | `lib/gemini.js` → `runWithFallback`, `callGemini` |
| 5.0 Guardrails | Server | `lib/gemini.js` → `cleanAnalysis`, `cleanExtra` |
| 6.0 Render report | Browser | `app.js` → `renderResults`, `radarChart`, `runTool` |
| 7.0 Manage history | Browser | `app.js` → `saveToHistory`, `renderHistory`, `renderTrend` |

---

## Level 2 — Processes 4.0 and 5.0 in detail

How one analysis request becomes a safe answer, including model fallback.

```mermaid
flowchart TB
    IN(["Validated input +<br/>built prompt"])
    M1(["4.1 Try gemini-3.5-flash-lite<br/>timeout up to 25 s"])
    M2(["4.2 Try gemini-3.1-flash-lite"])
    M3(["4.3 Try gemini-3.6-flash"])
    R{"Error retryable?<br/>404 · 429 · 500 · 503 · timeout"}
    B{"Time left in<br/>52 s budget?"}
    F(["Return friendly error<br/>to the browser"])
    J(["5.1 Parse JSON"])
    C1(["5.2 Clamp scores to 0–100"])
    C2(["5.3 Drop missing keywords<br/>that appear in the resume"])
    C3(["5.4 Normalise lists,<br/>strip bullet markers"])
    OUT(["Clean analysis to<br/>6.0 Render report"])

    IN --> M1
    M1 -- "success" --> J
    M1 -- "failure" --> R
    R -- "no: bad key or bad request" --> F
    R -- "yes" --> B
    B -- "yes: next model" --> M2
    B -- "no" --> F
    M2 -- "success" --> J
    M2 -- "failure" --> M3
    M3 -- "success" --> J
    M3 -- "failure" --> F
    J --> C1 --> C2 --> C3 --> OUT
```

---

## Data stores

| Store | Location | Contents | Lifetime |
|---|---|---|---|
| D1 `resumex.history.v1` | Browser localStorage | Up to 15 entries: `{id, date, mode, jobTitle, jdKey, score, previous, result}`. `result` holds the analysis only, **never the resume text** | Until the user clears history or browser data |
| D1 `resumex.theme`, `resumex.lang` | Browser localStorage | `"light"`/`"dark"`, `"en"`/`"hi"` | Same |
| D2 `GEMINI_API_KEY` | Vercel environment variable (`.env.local` when local) | The Gemini API key | Server only. Never sent to the browser or committed |
| D3 Prompt library | `lib/prompts.js` | Reviewer roles, prompt versions v1/v2, cover letter and interview prompts, JSON schemas | Versioned in git |

Resumex has **no database**. Resume text exists only in the browser tab and in the single request to Gemini.

---

## Trust boundaries

```mermaid
flowchart LR
    subgraph T1["Untrusted: browser"]
        A["User input<br/>(may contain injected instructions)"]
        H["Rendered AI text"]
    end
    subgraph T2["Trusted: Vercel function"]
        V["Validation + rate limit"]
        K[("API key")]
    end
    subgraph T3["External: Google"]
        GM["Gemini model"]
    end
    A -- "checked: size, mode, method" --> V
    V -- "input wrapped in resume and job tags" --> GM
    K -. "request header only, never returned" .-> GM
    GM -- "JSON constrained by schema" --> V
    V -- "guardrailed JSON, escaped on display" --> H
```

| Boundary crossing | Risk | Control |
|---|---|---|
| Browser → server | Oversized or malformed input, abuse | 50–20,000 character limits, mode whitelist, POST only, 10 requests/min per IP |
| Server → Gemini | Prompt injection hidden in a resume | Input placed inside `<resume>` / `<job_description>` tags, model told to ignore and flag instructions inside them |
| Server → Gemini | Leaking the API key | Key sent only in the `x-goog-api-key` header from the server, never in a URL or response |
| Gemini → server | Invalid or invented output | `responseSchema` JSON, score clamping, keyword cross-check against the resume, honesty rules in the prompt |
| Server → browser | Script injection through AI text | Every AI string is HTML-escaped before it is inserted into the page |

---

## Message formats

**`POST /api/analyze`** request
```json
{ "resume": "string (50–20,000 chars)", "jobDesc": "string (50–20,000 chars)",
  "mode": "general | tech | fresher | changer", "language": "en | hi" }
```

Response `200`
```json
{
  "analysis": {
    "ats_score": 75,
    "score_breakdown": { "skills": 75, "experience": 80, "keywords": 70, "presentation": 72 },
    "summary": "string",
    "strengths": ["string"],
    "missing_keywords": ["string"],
    "skill_gaps": [{ "skill": "string", "priority": "must-have | nice-to-have", "how_to_close": "string" }],
    "improvements": ["string"],
    "bullet_rewrites": [{ "original": "string", "improved": "string with [placeholders]" }],
    "guardrail_removed": ["keywords the model wrongly called missing"]
  },
  "model": "gemini-3.5-flash-lite", "version": "v2", "mode": "fresher", "language": "en"
}
```

**`POST /api/generate`** request: the same fields plus `"type": "cover_letter" | "interview"`.

Response `200`: `{ "type", "model", "result" }`, where `result` is `{ "subject", "body" }` for a cover letter, or `{ "questions": [{ "question", "category", "why_asked", "how_to_answer" }] }` for interview prep.

Errors: `400` invalid input · `405` wrong method · `429` rate limited or AI busy · `500` key missing · `502` AI failure. Each one returns `{ "error": "message for the user" }`.

---

## Deployment

```mermaid
flowchart LR
    DEV["Developer laptop<br/>npm run dev · npm run eval"] -- "git push" --> GH["GitHub repository"]
    GH -- "auto-deploy on push to main" --> VC["Vercel"]
    VC --> ST["Static files<br/>index.html · styles.css · app.js"]
    VC --> FN["Serverless functions<br/>api/analyze · api/generate<br/>60 s limit"]
    ENV[("Vercel env var<br/>GEMINI_API_KEY")] --> FN
    FN --> GEM["Gemini API"]
```
