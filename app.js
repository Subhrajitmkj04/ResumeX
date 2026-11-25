// Resumex front end: inputs, PDF text extraction, calling the API,
// rendering the review, history, dark mode and the printable report.

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

const MODE_LABELS = {
  general: "Career Coach",
  tech: "Tech Recruiter",
  fresher: "Fresh Graduate",
  changer: "Career Changer",
};
const HISTORY_KEY = "resumex.history.v1";
const HISTORY_MAX = 15;
const PDFJS_VERSION = "3.11.174";
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
const DEFAULT_FILE_NOTE = "The text is read in your browser. The file itself isn't uploaded.";

let mode = "general";
let language = "en";
// The inputs behind the review on screen, so the toolkit can reuse them.
let lastInputs = null;

// Everything the AI returns is untrusted text: always escape before inserting.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// Escape, then mark [placeholders] the candidate must fill in themselves.
function withPlaceholders(value) {
  return esc(value).replace(/\[([^\]]{1,40})\]/g, '<span class="placeholder">[$1]</span>');
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

/* Theme */

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function updateThemeButton() {
  els.themeToggle.textContent = currentTheme() === "dark" ? "Light mode" : "Dark mode";
}

els.themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("resumex.theme", next); } catch { /* ignore */ }
  updateThemeButton();
});

/* Reviewer and language */

function setMode(next) {
  mode = MODE_LABELS[next] ? next : "general";
  document.querySelectorAll(".mode").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
}
document.querySelectorAll(".mode").forEach((btn) => btn.addEventListener("click", () => setMode(btn.dataset.mode)));

function setLanguage(lang) {
  language = lang === "hi" ? "hi" : "en";
  document.querySelectorAll(".seg").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === language)));
  try { localStorage.setItem("resumex.lang", language); } catch { /* ignore */ }
}
document.querySelectorAll(".seg").forEach((btn) => btn.addEventListener("click", () => setLanguage(btn.dataset.lang)));
try { setLanguage(localStorage.getItem("resumex.lang") || "en"); } catch { setLanguage("en"); }

/* Character counts */

function updateCounts() {
  els.resumeCount.textContent = `${els.resume.value.trim().length.toLocaleString()} characters`;
  els.jobCount.textContent = `${els.jobDesc.value.trim().length.toLocaleString()} characters`;
}
els.resume.addEventListener("input", updateCounts);
els.jobDesc.addEventListener("input", updateCounts);

/* PDF / TXT upload */

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
        reject(new Error("the PDF reader couldn't load. Check your internet connection."));
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
  els.fileStatus.className = `drop-note ${kind}`.trim();
}

async function handleFile(file) {
  if (!file) return;
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const isTxt = file.type === "text/plain" || /\.txt$/i.test(file.name);
  if (!isPdf && !isTxt) return setFileStatus("Please choose a PDF or a .txt file.", "err");
  if (file.size > 5 * 1024 * 1024) return setFileStatus("That file is over 5 MB. Please use a smaller one.", "err");

  setFileStatus(`Reading ${file.name}…`);
  try {
    const text = isPdf ? await pdfToText(file) : (await file.text()).trim();
    if (text.length < 50) {
      return setFileStatus(isPdf
        ? "There's no selectable text in this PDF. It's probably a scanned image, so paste the text instead."
        : "That file is almost empty.", "err");
    }
    els.resume.value = text;
    updateCounts();
    setFileStatus(`Read ${text.length.toLocaleString()} characters from ${file.name}. Check the text below before you continue.`, "ok");
  } catch (err) {
    setFileStatus(`Couldn't read the file: ${err.message}`, "err");
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

/* Review */

function showError(title, detail) {
  els.results.innerHTML = `<div class="error" role="alert"><strong>${esc(title)}</strong>${esc(detail)}</div>`;
}

function setBusy(busy) {
  els.analyzeBtn.disabled = busy;
  els.analyzeBtn.innerHTML = busy ? '<span class="dots">Reviewing</span>' : "Review my resume";
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

// Same job description + reviewer → same key, so a second review can show progress.
function jobKey(jobDesc, usedMode) {
  const text = `${usedMode}|${jobDesc.toLowerCase().replace(/\s+/g, " ").trim()}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function guessJobTitle(jobDesc) {
  const line = jobDesc.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 2) || "Job description";
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

async function analyze() {
  const resume = els.resume.value.trim();
  const jobDesc = els.jobDesc.value.trim();

  if (!resume || !jobDesc) {
    return showError("Both boxes need text.", " Add your resume (paste it or upload a PDF) and the job description.");
  }
  if (resume.length < 50 || jobDesc.length < 50) {
    return showError("That's too short to review.", " Paste the whole resume and the complete job description.");
  }
  if (location.protocol === "file:") {
    return showError("The reviewer isn't running.", " Start it with `npm run dev` and open http://localhost:3000, or use the live site.");
  }

  setBusy(true);
  els.results.innerHTML = `<p class="status">Reading your resume as a ${esc(MODE_LABELS[mode])} would<span class="dots"></span></p>`;

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
    renderReport(entry);
  } catch (err) {
    showError("The review didn't go through.", ` ${err.message} If it keeps happening, wait a minute and try again.`);
  } finally {
    setBusy(false);
  }
}

function verdict(score) {
  if (score >= 80) return { color: "var(--good)", text: "Strong match for this job." };
  if (score >= 60) return { color: "var(--fair)", text: "A good match, with a few clear gaps to close." };
  if (score >= 40) return { color: "var(--fair)", text: "A partial match. It needs real changes for this job." };
  return { color: "var(--poor)", text: "A weak match for this job as the resume stands." };
}

function renderReport(entry) {
  const { analysis: a, model, version, mode: usedMode } = entry.result;
  const score = a.ats_score;
  const v = verdict(score);
  const live = lastInputs && lastInputs.id === entry.id;
  const when = new Date(entry.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  let change = "";
  if (entry.previous) {
    const diff = score - entry.previous.score;
    const since = new Date(entry.previous.date).toLocaleDateString(undefined, { dateStyle: "medium" });
    change = diff > 0 ? `<p class="change up">Up ${diff} since your review on ${esc(since)}</p>`
      : diff < 0 ? `<p class="change down">Down ${Math.abs(diff)} since your review on ${esc(since)}</p>`
        : `<p class="change same">Same as your review on ${esc(since)}</p>`;
  }

  const parts = [
    ["Skills", a.score_breakdown.skills],
    ["Experience", a.score_breakdown.experience],
    ["Keywords", a.score_breakdown.keywords],
    ["Presentation", a.score_breakdown.presentation],
  ].map(([label, value]) => `
    <div class="part"><span>${label}</span><span class="part-bar"><span style="width:${value}%"></span></span><b>${value}</b></div>`).join("");

  const strengths = a.strengths.length
    ? `<ul class="plain-list">${a.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
    : '<p class="muted">Nothing stood out yet.</p>';

  const keywords = a.missing_keywords.length
    ? `<div class="tags">${a.missing_keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join("")}</div>`
    : '<p class="muted">Nothing important is missing.</p>';

  const gaps = a.skill_gaps.length
    ? `<div class="gaps">${a.skill_gaps.map((g) => `
        <div class="gap">
          <span class="gap-skill">${esc(g.skill)}</span>
          <span class="priority ${g.priority === "must-have" ? "must" : "nice"}">${g.priority === "must-have" ? "must have" : "nice to have"}</span>
          <span class="gap-how">${esc(g.how_to_close)}</span>
        </div>`).join("")}</div>`
    : '<p class="muted">No significant gaps for this job.</p>';

  const improvements = a.improvements.length
    ? `<ol class="numbered">${a.improvements.map((i) => `<li><span>${esc(i)}</span></li>`).join("")}</ol>`
    : '<p class="muted">No changes suggested.</p>';

  const rewrites = a.bullet_rewrites.length
    ? a.bullet_rewrites.map((b) => `
        <div class="rewrite">
          <span class="label">Now</span><span class="was">${esc(b.original)}</span>
          <span class="label">Try</span><span>${withPlaceholders(b.improved)}</span>
        </div>`).join("")
    : '<p class="muted">Your bullet points already read well.</p>';

  const toolkit = live
    ? `<div class="toolkit no-print">
         <button type="button" class="btn btn-secondary" data-tool="cover_letter">Write a cover letter</button>
         <button type="button" class="btn btn-secondary" data-tool="interview">Practise interview questions</button>
       </div>
       <div id="toolOutput" class="tool-output"></div>`
    : '<p class="muted">Run a new review to use these. Saved reviews don\'t keep your resume text.</p>';

  els.results.innerHTML = `
    <article class="report">
      <header class="report-head">
        <div>
          <p class="eyebrow">Review by the ${esc(MODE_LABELS[usedMode] || usedMode)}${entry.result.language === "hi" ? " · हिंदी" : ""}</p>
          <h2>${esc(entry.jobTitle)}</h2>
          <p class="report-meta">${esc(when)} · ${esc(model)} · prompt ${esc(version)}</p>
        </div>
        <button id="downloadBtn" class="btn btn-secondary no-print" type="button">Save as PDF</button>
      </header>

      <div class="overview">
        <div>
          <p class="score" style="color:${v.color}">${score}<small> / 100</small></p>
          <p class="verdict">${esc(v.text)}</p>
          ${change}
          <div class="parts">${parts}</div>
        </div>
        <div>
          <p class="summary">${esc(a.summary || "No summary was returned.")}</p>
          <h3>What already works</h3>
          ${strengths}
        </div>
      </div>

      <section class="section">
        <h3>Missing from your resume</h3>
        <p class="section-intro">Terms the job description uses that your resume doesn't. Add the ones that are true for you, in the job's own wording.</p>
        ${keywords}
      </section>

      <section class="section">
        <h3>Skill gaps</h3>
        <p class="section-intro">What this role needs that your resume doesn't show yet, and a practical way to close each gap.</p>
        ${gaps}
      </section>

      <section class="section">
        <h3>What to change</h3>
        ${improvements}
      </section>

      <section class="section">
        <h3>Stronger bullet points</h3>
        <p class="section-intro">Lines from your resume, rewritten. Anything in <span class="placeholder">[brackets]</span> is a number only you know, so fill it in truthfully or leave it out.</p>
        ${rewrites}
      </section>

      <section class="section no-print">
        <h3>Next: apply for it</h3>
        <p class="section-intro">A cover letter and interview questions for this job, written only from what's in your resume.</p>
        ${toolkit}
      </section>

      <p class="report-foot no-print">Make the changes, then review the resume again. You'll see how far the score moved.</p>
    </article>`;

  $("downloadBtn").addEventListener("click", () => window.print());
  els.results.querySelectorAll("[data-tool]").forEach((btn) => btn.addEventListener("click", () => runTool(btn.dataset.tool, btn)));
  els.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* Cover letter and interview practice */

const TOOL_LABELS = { cover_letter: "Write a cover letter", interview: "Practise interview questions" };
const KIND_LABELS = { technical: "Technical", gap: "About a gap", project: "About your project", behavioral: "Behavioural" };

async function runTool(type, button) {
  if (!lastInputs) return;
  const output = $("toolOutput");
  const buttons = els.results.querySelectorAll("[data-tool]");
  buttons.forEach((b) => { b.disabled = true; });
  button.innerHTML = '<span class="dots">Writing</span>';
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
          copyBtn.textContent = "Copied";
        } catch {
          copyBtn.textContent = "Couldn't copy. Select the text instead.";
        }
      });
    }
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    output.innerHTML = `<div class="error" role="alert"><strong>That didn't work.</strong>${esc(err.message)}</div>`;
  } finally {
    buttons.forEach((b) => { b.disabled = false; b.textContent = TOOL_LABELS[b.dataset.tool]; });
  }
}

function renderLetter(letter) {
  return `
    <div class="tool-head">
      <h4>Cover letter</h4>
      <button id="copyLetterBtn" type="button" class="text-btn">Copy to clipboard</button>
    </div>
    <p class="letter-subject"><span class="muted">Subject:</span> ${esc(letter.subject)}</p>
    <div class="letter">${withPlaceholders(letter.body)}</div>`;
}

function renderInterview(prep) {
  if (!prep.questions.length) return '<p class="muted">No questions came back. Please try again.</p>';
  return `
    <div class="tool-head"><h4>Questions you're likely to get</h4></div>
    <ol class="qa">${prep.questions.map((q) => `
      <li>
        <span class="qa-kind">${esc(KIND_LABELS[q.category] || q.category)}</span>
        <p class="qa-q">${esc(q.question)}</p>
        <p class="why">${esc(q.why_asked)}</p>
        <p class="how"><strong>How to answer:</strong> ${esc(q.how_to_answer)}</p>
      </li>`).join("")}</ol>`;
}

/* History */

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
    els.historyList.innerHTML = '<li class="history-empty">Your reviews will appear here.</li>';
    return;
  }
  els.historyList.innerHTML = items.map((e) => `
    <li>
      <button class="history-item" type="button" data-id="${esc(e.id)}">
        <span class="history-score">${esc(e.score)}</span>
        <span>
          <span class="history-title">${esc(e.jobTitle)}</span>
          <span class="history-sub">${esc(MODE_LABELS[e.mode] || e.mode)} · ${esc(new Date(e.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</span>
        </span>
        <span class="history-open">Open</span>
      </button>
    </li>`).join("");
}

els.historyList.addEventListener("click", (e) => {
  const btn = e.target.closest(".history-item");
  if (!btn) return;
  const entry = loadHistory().find((h) => String(h.id) === btn.dataset.id);
  if (entry) renderReport(entry);
});

els.clearHistoryBtn.addEventListener("click", () => {
  if (!confirm("Delete all saved reviews from this browser?")) return;
  storage.set(HISTORY_KEY, []);
  renderHistory();
});

/* Sample and clear */

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
  setMode("fresher");
  setFileStatus("Sample loaded: a final-year student applying for an ML internship.", "ok");
  updateCounts();
});

els.clearBtn.addEventListener("click", () => {
  els.resume.value = "";
  els.jobDesc.value = "";
  els.results.innerHTML = "";
  setFileStatus(DEFAULT_FILE_NOTE);
  updateCounts();
});

els.analyzeBtn.addEventListener("click", analyze);

/* Start */

if (location.protocol === "file:") els.fileNotice.hidden = false;
setMode("general");
updateThemeButton();
updateCounts();
renderHistory();
