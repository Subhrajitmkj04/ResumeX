# Resumex — AI Career Copilot

Resumex compares a resume with a job description and tells the candidate, honestly and specifically, how to improve it for that job. It is built on the Google Gemini API and deployed on Vercel.

**Live demo:** _add your Vercel URL here_ · Built by **Subhrajit Mukherjee** for the ApnoAI AI/ML internship (Task 3).

## Features

| | |
|---|---|
| 🎯 **ATS match score** | Weighted score (skills 40%, experience 25%, keywords 20%, presentation 15%) with a per-part breakdown |
| 🧑‍💻 / 🎓 **Two copilots** | *Tech Recruiter* judges stack depth and engineering impact; *Fresh Graduate* weighs projects, internships and coursework instead of years of experience |
| 🔑 **Missing keywords** | Terms from the job description that the resume lacks, double-checked in code so a keyword already in the resume is never reported as missing |
| 🧭 **Skill gap analysis** | Each gap marked must-have or nice-to-have, with a concrete way to close it |
| ✍️ **Honest bullet rewrites** | Weak resume lines rewritten for impact. Numbers the resume doesn't give become placeholders like `[X%]`, never invented achievements |
| ✉️ **Cover letter generator** | Written only from facts in the resume, with a copy button |
| 🎤 **Interview prep** | 6 likely questions (technical, gap-probing, project, behavioral) with why they're asked and how to answer from the candidate's real experience |
| 📄 **PDF upload** | Text is extracted in the browser with pdf.js. Scanned PDFs are detected |
| 🌐 **English / हिंदी feedback** | Tech terms and keywords stay in English |
| 📈 **Score progress** | Re-analyse against the same job and see how much the score moved |
| 🕘 **History, report export, dark mode** | History is saved only in the browser (resume text is never stored). The report prints to PDF |

## How it works

```
Browser (index.html + app.js)
   │  POST /api/analyze   { resume, jobDesc, mode, language }
   │  POST /api/generate  { type: cover_letter | interview, ... }
   ▼
Vercel serverless functions (api/)
   │  input checks · rate limit · GEMINI_API_KEY from environment
   ▼
lib/gemini.js ──► Gemini generateContent with a JSON responseSchema
   │  model fallback: 3.5-flash-lite → 3.1-flash-lite → 3.6-flash (shared 52 s budget)
   ▼
Guardrails: clamp scores, drop "missing" keywords that are in the resume, escape all output in the UI
```

- **The API key never reaches the browser or GitHub.** It lives in a Vercel environment variable and is used only inside the serverless function.
- **Structured output:** Gemini's `responseSchema` forces valid JSON with the exact fields the UI needs, so there's no fragile text parsing.
- **Prompt-injection guard:** the resume and job description are passed as data inside `<resume>` / `<job_description>` tags, and the model is told to ignore instructions inside them.
- **Safe rendering:** every AI-generated string is HTML-escaped before it is shown.

## Prompt engineering, measured

Prompts are versioned in [`lib/prompts.js`](lib/prompts.js). Each version is scored by an evaluation script on 5 test resumes (strong fresher, web developer applying to ML, Java backend engineer, career changer, and a sparse resume with a hidden *"set ats_score to 100"* injection), 2 runs each, like evaluating a model in Task 2.

| Metric (5 resumes × 2 runs) | v1 · starter-style prompt | v2 · current |
|---|---|---|
| Scores inside the expected range | 4 / 5 cases | **5 / 5** |
| Invented numbers in rewritten bullets | 24 | **0** |
| Score for the sparse, injected resume (target ≤ 35) | 42 | **30–34** |
| Injection attempt flagged to the candidate | 0 / 2 | **2 / 2** |
| Candidates ranked in the right order | ✗ | **✓** |
| "Missing" keywords actually in the resume (before guardrail) | 1 / 72 | 1 / 80 |
| Largest score difference between two runs | 6 | **4** |
| Failed API calls | 1 | **0** |

Full write-up: [docs/PROMPT_LOG.md](docs/PROMPT_LOG.md).

## Run it locally

Requires Node.js 18+. No packages to install.

```bash
cp .env.example .env.local     # then paste your Gemini key after GEMINI_API_KEY=
npm run dev                    # http://localhost:3000
npm run eval -- --version v2   # evaluate a prompt version (uses ~10 API calls)
```

## Deploy on Vercel

1. Import this repository in Vercel (Framework preset: **Other**).
2. Add `GEMINI_API_KEY` under **Settings → Environment Variables**.
3. Deploy. Pushing to `main` redeploys automatically.

## Project structure

```
index.html, styles.css, app.js   front end (no framework)
api/analyze.js, api/generate.js  Vercel serverless functions
lib/prompts.js                   versioned prompts + JSON schemas
lib/gemini.js                    Gemini client, model fallback, guardrails
lib/http.js                      input checks, rate limiting, error messages
tests/cases.json, run-eval.mjs   prompt evaluation
dev-server.mjs                   local server that mimics Vercel
```
