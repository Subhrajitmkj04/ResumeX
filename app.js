// Resumex front end: inputs, PDF text extraction, calling /api/analyze,
// rendering results, history, dark mode and the printable report.

const $ = (id) => document.getElementById(id);
const els = {
  resume: $("resume"),
  jobDesc: $("jobDesc"),
  resumeCount: $("resumeCount"),
  jobCount: $("jobCount"),
  file: $("resumeFile"),
  dropZone: $("dropZone"),
  fileStatus: $("fileStatus"),
  analyzeBtn: $("analyzeBtn"),
  sampleBtn: $("sampleBtn"),
  clearBtn: $("clearBtn"),
  results: $("results"),
  historyList: $("historyList"),
  clearHistoryBtn: $("clearHistoryBtn"),
  themeToggle: $("themeToggle"),
  fileNotice: $("fileNotice"),
};

const MODE_LABELS = { tech: "Tech Recruiter", fresher: "Fresh Graduate" };
const HISTORY_KEY = "resumex.history.v1";
const HISTORY_MAX = 15;
const PDFJS_VERSION = "3.11.174";
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

let mode = "tech";
let language = "en";
// The inputs behind the analysis on screen, so the toolkit can reuse them.
let lastInputs = null;

// Everything the AI returns is untrusted text: always escape before inserting.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

/* ── Theme ─────────────────────────────────────────── */

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButton() {
  const dark = currentTheme() === "dark";
  els.themeToggle.querySelector(".theme-icon").textContent = dark ? "☀️" : "🌙";
  els.themeToggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
}

els.themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("resumex.theme", next); } catch { /* ignore */ }
  updateThemeButton();
});

/* ── Mode switch ───────────────────────────────────── */

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    mode = btn.dataset.mode;
    document.querySelectorAll(".mode-btn").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });
});

/* ── Feedback language ─────────────────────────────── */

function setLanguage(lang) {
  language = lang === "hi" ? "hi" : "en";
  document.querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === language)));
  try { localStorage.setItem("resumex.lang", language); } catch { /* ignore */ }
}
document.querySelectorAll(".seg-btn").forEach((btn) => btn.addEventListener("click", () => setLanguage(btn.dataset.lang)));
try { setLanguage(localStorage.getItem("resumex.lang") || "en"); } catch { setLanguage("en"); }

/* ── Character counts ──────────────────────────────── */

function updateCounts() {
  els.resumeCount.textContent = `${els.resume.value.trim().length.toLocaleString()} characters`;
  els.jobCount.textContent = `${els.jobDesc.value.trim().length.toLocaleString()} characters`;
}
els.resume.addEventListener("input", updateCounts);
els.jobDesc.addEventListener("input", updateCounts);

/* ── PDF / TXT upload ──────────────────────────────── */

let pdfjsPromise;
function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${PDFJS_BASE}/pdf.min.js`;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => {
        pdfjsPromise = null;
        reject(new Error("Could not load the PDF reader. Check your internet connection."));
      };
      document.head.appendChild(script);
    });
  }
  return pdfjsPromise;
}

async function pdfToText(file) {
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      text += item.str + (item.hasEOL ? "\n" : " ");
    }
    pages.push(text);
  }
  return pages.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function setFileStatus(message, kind = "") {
  els.fileStatus.textContent = message;
  els.fileStatus.className = kind;
}

async function handleFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isTxt = file.type === "text/plain" || /\.txt$/i.test(file.name);
  if (!isPdf && !isTxt) return setFileStatus("Please choose a PDF or TXT file.", "err");
  if (file.size > 5 * 1024 * 1024) return setFileStatus("That file is over 5 MB. Please use a smaller file.", "err");

  setFileStatus(`Reading ${file.name}…`);
  try {
    const text = isPdf ? await pdfToText(file) : (await file.text()).trim();
    if (text.length < 50) {
      return setFileStatus(isPdf
        ? "No selectable text found. This PDF may be a scanned image, so paste the text instead."
        : "The file is almost empty.", "err");
    }
    els.resume.value = text;
    updateCounts();
    setFileStatus(`✓ Extracted ${text.length.toLocaleString()} characters from ${file.name}. Check the text below.`, "ok");
  } catch (err) {
    setFileStatus(`Could not read the file: ${err.message}`, "err");
  } finally {
    els.file.value = "";
  }
}

els.file.addEventListener("change", () => handleFile(els.file.files[0]));
["dragenter", "dragover"].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((type) => els.dropZone.addEventListener(type, (e) => {
  e.preventDefault();
  els.dropZone.classList.remove("dragging");
}));
els.dropZone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

/* ── Analyze ───────────────────────────────────────── */

function showError(title, detail) {
  els.results.innerHTML = `
    <div class="error-box" role="alert">
      <span class="emoji" aria-hidden="true">⚠️</span>
      <div><strong>${esc(title)}</strong><br>${esc(detail)}</div>
    </div>`;
}

function setBusy(busy) {
  els.analyzeBtn.disabled = busy;
  els.analyzeBtn.innerHTML = busy
    ? '<span class="spinner small" aria-hidden="true"></span> Analyzing…'
    : '<span aria-hidden="true">🚀</span> Analyze Resume';
}

async function analyze() {
  const resume = els.resume.value.trim();
  const jobDesc = els.jobDesc.value.trim();

  if (!resume || !jobDesc) {
    return showError("Please fill in both fields", "Add your resume (paste it or upload a PDF) and the job description.");
  }
  if (resume.length < 50 || jobDesc.length < 50) {
    return showError("Content too short", "Paste the full resume and the complete job description for an accurate analysis.");
  }
  if (location.protocol === "file:") {
    return showError("The AI server isn't running", "Run `npm run dev` in the project folder and open http://localhost:3000, or use the live site.");
  }

  setBusy(true);
  els.results.innerHTML = `
    <div class="loading">
      <div class="spinner" aria-hidden="true"></div>
      <p><strong>Reading your resume like a ${esc(MODE_LABELS[mode])}…</strong></p>
      <p style="font-size:13px;margin-top:6px">This usually takes 5–15 seconds.</p>
    </div>`;

  try {
    const data = await postJson("/api/analyze", { resume, jobDesc, mode, language });

    const jdKey = jobKey(jobDesc, data.mode);
    const previous = loadHistory().find((h) => h.jdKey === jdKey);
    const entry = {
      id: Date.now(),
      date: new Date().toISOString(),
      mode: data.mode,
      jobTitle: guessJobTitle(jobDesc),
      jdKey,
      score: data.analysis.ats_score,
      previous: previous ? { score: previous.score, date: previous.date } : null,
      result: data,
    };
    lastInputs = { id: entry.id, resume, jobDesc, mode: data.mode, language };
    saveToHistory(entry);
    renderResults(entry);
  } catch (err) {
    showError("Analysis failed", `${err.message} If it keeps happening, wait a minute and try again.`);
  } finally {
    setBusy(false);
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server error ${response.status}`);
  return data;
}

// Same job description + mode → same key, so re-analyses can show progress.
function jobKey(jobDesc, usedMode) {
  const text = `${usedMode}|${jobDesc.toLowerCase().replace(/\s+/g, " ").trim()}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function guessJobTitle(jobDesc) {
  const line = jobDesc.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 2) || "Job description";
  return line.length > 70 ? `${line.slice(0, 67)}…` : line;
}

/* ── Results ───────────────────────────────────────── */

function scoreStyle(score) {
  if (score >= 80) return { color: "var(--success)", message: "Excellent match. Your resume is well aligned." };
  if (score >= 60) return { color: "var(--gold)", message: "Good match. A few changes will lift it further." };
  if (score >= 40) return { color: "var(--coral)", message: "Fair match. Consider significant updates." };
  return { color: "var(--danger)", message: "Low match. Major revisions needed for this role." };
}

function list(items, cls = "insight-list") {
  if (!items.length) return '<p class="empty">Nothing to show.</p>';
  return `<ul class="${cls}">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
}

function renderResults(entry) {
  const { analysis: a, model, version, mode: usedMode } = entry.result;
  const score = a.ats_score;
  const style = scoreStyle(score);
  const breakdownRows = [
    ["Skills", a.score_breakdown.skills],
    ["Experience", a.score_breakdown.experience],
    ["Keywords", a.score_breakdown.keywords],
    ["Presentation", a.score_breakdown.presentation],
  ].map(([label, value]) => `
    <div class="bar-row">
      <div class="bar-label"><span>${label}</span><strong>${value}</strong></div>
      <div class="bar-track"><div class="bar-fill" style="width:${value}%"></div></div>
    </div>`).join("");

  const gaps = a.skill_gaps.length
    ? `<ul class="gap-list">${a.skill_gaps.map((g) => `
        <li class="gap-item">
          <div class="gap-top">
            <span class="gap-skill">${esc(g.skill)}</span>
            <span class="pill ${g.priority === "must-have" ? "pill-must" : "pill-nice"}">${esc(g.priority)}</span>
          </div>
          <div class="gap-how">${esc(g.how_to_close)}</div>
        </li>`).join("")}</ul>`
    : '<p class="empty">No major skill gaps found for this role.</p>';

  const rewrites = a.bullet_rewrites.length
    ? a.bullet_rewrites.map((b) => `
        <div class="rewrite">
          <div class="before"><span class="tag">Before</span><span class="text">${esc(b.original)}</span></div>
          <div class="after"><span class="tag">After</span>${esc(b.improved)}</div>
        </div>`).join("")
    : '<p class="empty">Your bullet points already read well.</p>';

  const keywords = a.missing_keywords.length
    ? `<div class="keyword-list">${a.missing_keywords.map((k) => `<span class="keyword">${esc(k)}</span>`).join("")}</div>`
    : '<p class="empty">No important keywords are missing. Nice!</p>';

  const when = new Date(entry.date).toLocaleString();
  const live = lastInputs && lastInputs.id === entry.id;

  let delta = "";
  if (entry.previous) {
    const diff = score - entry.previous.score;
    const since = new Date(entry.previous.date).toLocaleDateString();
    delta = diff > 0 ? `<span class="delta up">▲ +${diff} since your last check (${esc(since)})</span>`
      : diff < 0 ? `<span class="delta down">▼ ${diff} since your last check (${esc(since)})</span>`
        : `<span class="delta same">No change since your last check (${esc(since)})</span>`;
  }

  const toolkit = live
    ? `<div class="toolkit-buttons no-print">
         <button type="button" class="btn btn-teal" data-tool="cover_letter">✉️ Write my cover letter</button>
         <button type="button" class="btn btn-teal" data-tool="interview">🎤 Prep my interview</button>
       </div>
       <div id="toolOutput" class="tool-output"></div>`
    : '<p class="tool-note">To write a cover letter or prepare for the interview, run a new analysis. Saved results don\'t keep your resume text.</p>';

  els.results.innerHTML = `
    <div class="results-toolbar">
      <p class="meta">Analyzed as <strong>${esc(MODE_LABELS[usedMode] || usedMode)}</strong> · ${esc(entry.jobTitle)} · ${esc(when)}<br>
        Model <strong>${esc(model)}</strong> · Prompt <strong>${esc(version)}</strong>${entry.result.language === "hi" ? " · हिंदी" : ""}</p>
      <button id="downloadBtn" class="btn btn-ghost no-print" type="button">⬇️ Download report (PDF)</button>
    </div>

    <div class="result-grid">
      <div class="result-card score-card">
        <h4 style="justify-content:center">🎯 ATS Match Score</h4>
        <div class="score-ring" style="--deg:${score * 3.6}deg;--ring:${style.color}">
          <div class="score-ring-inner">
            <div class="score-number" style="color:${style.color}">${score}</div>
            <div class="score-label">out of 100</div>
          </div>
        </div>
        <p class="score-message">${esc(style.message)}</p>
        ${delta}
        <div class="breakdown">${breakdownRows}</div>
      </div>

      <div>
        <div class="result-card">
          <h4>📝 Summary</h4>
          <p class="summary-text">${esc(a.summary || "No summary provided.")}</p>
        </div>
        <div class="result-card">
          <h4>✅ What your resume does well</h4>
          ${list(a.strengths)}
        </div>
      </div>
    </div>

    <div class="result-card">
      <h4>🔑 Missing keywords</h4>
      <p class="hint">Words from the job description that aren't in your resume. Add the ones that truly apply to you.</p>
      ${keywords}
    </div>

    <div class="result-card">
      <h4>🧭 Skill gap analysis</h4>
      <p class="hint">What this role needs that your resume doesn't show yet, and how to close each gap.</p>
      ${gaps}
    </div>

    <div class="result-card">
      <h4>💡 Recommended improvements</h4>
      ${list(a.improvements, "insight-list improvement-list")}
    </div>

    <div class="result-card">
      <h4>✍️ Stronger bullet points</h4>
      <p class="hint">Lines from your resume, rewritten to show impact. Only use numbers that are true for you.</p>
      ${rewrites}
    </div>

    <div class="result-card">
      <h4>🧰 Career toolkit</h4>
      <p class="hint">Turn this analysis into a cover letter or interview practice, written only from facts in your resume.</p>
      ${toolkit}
    </div>

    <div class="next-steps no-print">
      <strong>🎯 Next step:</strong> update your resume with the changes above and analyze it again. Resumex will show how much your score moved.
    </div>`;

  $("downloadBtn").addEventListener("click", () => window.print());
  els.results.querySelectorAll("[data-tool]").forEach((btn) => btn.addEventListener("click", () => runTool(btn.dataset.tool, btn)));
  els.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── Career toolkit ────────────────────────────────── */

const TOOL_LABELS = { cover_letter: "✉️ Write my cover letter", interview: "🎤 Prep my interview" };
const CATEGORY_LABELS = { technical: "Technical", gap: "Gap", project: "Your project", behavioral: "Behavioral" };

async function runTool(type, button) {
  if (!lastInputs) return;
  const output = $("toolOutput");
  const buttons = els.results.querySelectorAll("[data-tool]");
  buttons.forEach((b) => { b.disabled = true; });
  button.innerHTML = '<span class="spinner small" aria-hidden="true"></span> Writing…';
  output.innerHTML = "";

  try {
    const { resume, jobDesc, mode: usedMode } = lastInputs;
    const data = await postJson("/api/generate", { type, resume, jobDesc, mode: usedMode, language: lastInputs.language });
    output.innerHTML = type === "cover_letter" ? renderLetter(data.result) : renderInterview(data.result);
    const copyBtn = $("copyLetterBtn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(`Subject: ${data.result.subject}\n\n${data.result.body}`);
          copyBtn.textContent = "✓ Copied";
        } catch {
          copyBtn.textContent = "Copy failed. Select the text instead.";
        }
      });
    }
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    output.innerHTML = `<div class="error-box" role="alert"><span class="emoji" aria-hidden="true">⚠️</span><div><strong>Couldn't generate that</strong><br>${esc(err.message)}</div></div>`;
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.innerHTML = TOOL_LABELS[b.dataset.tool]; });
  }
}

function renderLetter(letter) {
  return `
    <div class="tool-head">
      <h5>✉️ Your cover letter</h5>
      <button id="copyLetterBtn" type="button" class="btn btn-ghost no-print">📋 Copy</button>
    </div>
    <p class="letter-subject"><strong>Subject:</strong> ${esc(letter.subject)}</p>
    <div class="letter">${esc(letter.body)}</div>
    <p class="tool-note" style="margin-top:8px">Fill in anything in [square brackets] with true details before sending.</p>`;
}

function renderInterview(prep) {
  if (!prep.questions.length) return '<p class="empty">No questions came back. Try again.</p>';
  return `
    <div class="tool-head"><h5>🎤 Likely interview questions</h5></div>
    <ol class="qa-list">${prep.questions.map((q) => `
      <li class="qa-item">
        <span class="pill pill-${esc(q.category)}">${esc(CATEGORY_LABELS[q.category] || q.category)}</span>
        <p class="qa-q">${esc(q.question)}</p>
        <p class="qa-why"><strong>Why they ask:</strong> ${esc(q.why_asked)}</p>
        <p class="qa-how"><strong>How to answer:</strong> ${esc(q.how_to_answer)}</p>
      </li>`).join("")}</ol>`;
}

/* ── History ───────────────────────────────────────── */

function loadHistory() {
  const items = storage.get(HISTORY_KEY, []);
  return Array.isArray(items) ? items.filter((e) => e && e.result && e.result.analysis) : [];
}

function saveToHistory(entry) {
  storage.set(HISTORY_KEY, [entry, ...loadHistory()].slice(0, HISTORY_MAX));
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  els.clearHistoryBtn.hidden = items.length === 0;
  if (!items.length) {
    els.historyList.innerHTML = '<li class="history-empty">No analyses yet. Your results will appear here.</li>';
    return;
  }
  els.historyList.innerHTML = items.map((e) => `
    <li>
      <button class="history-item" type="button" data-id="${esc(e.id)}">
        <span class="history-score">${esc(e.score)}</span>
        <span class="history-info">
          <span class="history-title">${esc(e.jobTitle)}</span>
          <span class="history-sub">${esc(MODE_LABELS[e.mode] || e.mode)} · ${esc(new Date(e.date).toLocaleString())}</span>
        </span>
      </button>
    </li>`).join("");
}

els.historyList.addEventListener("click", (e) => {
  const btn = e.target.closest(".history-item");
  if (!btn) return;
  const entry = loadHistory().find((h) => String(h.id) === btn.dataset.id);
  if (entry) renderResults(entry);
});

els.clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("Delete all saved analyses from this browser?")) return;
  storage.set(HISTORY_KEY, []);
  renderHistory();
});

/* ── Sample + clear ────────────────────────────────── */

const SAMPLE_RESUME = `Ananya Rao
Bengaluru, India · github.com/ananya-rao-ml

EDUCATION
B.Tech in Computer Science and Engineering, RV College of Engineering, 2022–2026 · CGPA 8.7/10
Relevant coursework: Machine Learning, Data Structures, DBMS, Probability and Statistics

EXPERIENCE
Machine Learning Intern, Finlytics (fintech startup) · May 2025 – July 2025
- Built a churn prediction model with scikit-learn and pandas on 120,000 customer records.
- Worked on feature engineering and model evaluation.
- Presented results to the product team.

PROJECTS
Tweet Sentiment Classifier · Python, PyTorch, Hugging Face Transformers
- Fine-tuned DistilBERT on 50,000 labelled tweets, reaching 91% accuracy and 0.90 F1.
- Did data cleaning and tokenization.
Movie Recommender · Python, pandas, NumPy
- Made a recommendation system using collaborative filtering.

SKILLS
Python, PyTorch, scikit-learn, pandas, NumPy, SQL, Git, Matplotlib, Jupyter

ACHIEVEMENTS
Kaggle Notebooks Expert · Top 8% in a Kaggle NLP competition`;

const SAMPLE_JOB = `Machine Learning Engineer Intern — Nimbus Analytics (Bengaluru, Hybrid)

About the role
Join our applied ML team to build NLP and forecasting models used by 200+ enterprise customers.

What you'll do
- Train, evaluate and improve machine learning models in Python
- Build data pipelines with pandas and SQL
- Deploy models as REST APIs using Docker
- Track experiments and communicate results to stakeholders

Requirements
- Final-year student or recent graduate in CS or a related field
- Strong Python; experience with PyTorch or TensorFlow and scikit-learn
- Understanding of model evaluation metrics (precision, recall, F1, ROC-AUC)
- Familiarity with NLP and transformer models
- Comfortable with SQL and Git

Nice to have
- Docker, FastAPI or Flask
- Cloud experience (AWS or GCP)
- MLOps tools such as MLflow`;

els.sampleBtn.addEventListener("click", () => {
  els.resume.value = SAMPLE_RESUME;
  els.jobDesc.value = SAMPLE_JOB;
  document.querySelector('.mode-btn[data-mode="fresher"]').click();
  setFileStatus("Sample loaded: a final-year student applying for an ML internship.", "ok");
  updateCounts();
});

els.clearBtn.addEventListener("click", () => {
  els.resume.value = "";
  els.jobDesc.value = "";
  els.results.innerHTML = "";
  setFileStatus("Text is extracted in your browser. The file is not uploaded anywhere.");
  updateCounts();
});

els.analyzeBtn.addEventListener("click", analyze);

/* ── Start ─────────────────────────────────────────── */

if (location.protocol === "file:") els.fileNotice.hidden = false;
updateThemeButton();
updateCounts();
renderHistory();
