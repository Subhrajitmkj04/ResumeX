// Evaluates a prompt version on the 5 test resumes, the way Task 2 evaluated a model.
//   npm run eval -- --version v1 --runs 2
// Needs GEMINI_API_KEY in .env.local. Writes tests/results/<version>.json
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../lib/env.js";
import { analyzeResume, appearsIn, normalize } from "../lib/gemini.js";
import { CURRENT_VERSION } from "../lib/prompts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(join(HERE, "..", ".env.local"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const version = arg("version", CURRENT_VERSION);
const runs = Number(arg("runs", 2));
const delayMs = Number(arg("delay", 4500));
const only = arg("case", null);

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing. Paste it into .env.local first.");
  process.exit(1);
}

const { jobs, cases } = JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GENERIC = [
  /tailor (your|the) resume/i, /add more details/i, /use action verbs/i, /quantify (your )?achievements/i,
  /proofread/i, /make it (more )?concise/i, /highlight (your )?skills/i,
];

// Does a quoted "original" bullet really come from the resume?
function quotedFromResume(line, resume) {
  const words = normalize(line).trim().split(" ").filter((w) => w.length > 2);
  if (!words.length) return false;
  const text = normalize(resume);
  return words.filter((w) => text.includes(` ${w} `)).length / words.length >= 0.8;
}

function checkRun(raw, resume, jobDesc) {
  const kws = Array.isArray(raw.missing_keywords) ? raw.missing_keywords : [];
  const imps = Array.isArray(raw.improvements) ? raw.improvements : [];
  const rewrites = Array.isArray(raw.bullet_rewrites) ? raw.bullet_rewrites : [];
  const falseMissing = kws.filter((k) => appearsIn(k, resume));
  const notInJd = kws.filter((k) => !appearsIn(k, jobDesc));
  const generic = imps.filter((i) => GENERIC.some((re) => re.test(i)) && i.split(" ").length < 18);
  const invented = rewrites.filter((r) => !quotedFromResume(r.original || "", resume));
  // Numbers in an "improved" bullet that appear nowhere in the resume = made-up achievements.
  const resumeNumbers = new Set((resume.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "")));
  const inventedNumbers = rewrites.flatMap((r) => (String(r.improved || "").replace(/\[[^\]]*\]/g, "").match(/\d+(?:[.,]\d+)?/g) || [])
    .map((n) => n.replace(",", "")).filter((n) => !resumeNumbers.has(n)));
  return {
    invented_numbers: inventedNumbers.length,
    score: Math.round(Number(raw.ats_score)),
    keywords: kws.length,
    false_missing: falseMissing,
    not_in_jd: notInJd,
    generic_improvements: generic.length,
    invented_originals: invented.length,
    rewrites: rewrites.length,
  };
}

const report = { version, runs, date: new Date().toISOString(), cases: [] };
let calls = 0;

for (const c of cases.filter((c) => !only || c.id === only)) {
  const jobDesc = jobs[c.job];
  const results = [];
  for (let r = 0; r < runs; r++) {
    if (calls++ > 0) await sleep(delayMs);
    try {
      const out = await analyzeResume({ resume: c.resume, jobDesc, mode: c.mode, apiKey, version });
      results.push({ model: out.model, ...checkRun(out.raw, c.resume, jobDesc), raw: out.raw });
    } catch (err) {
      results.push({ error: `${err.status || ""} ${err.message}`.trim() });
    }
  }
  const ok = results.filter((r) => !r.error);
  const scores = ok.map((r) => r.score);
  const summary = {
    id: c.id,
    name: c.name,
    expect: c.expect,
    scores,
    in_range: ok.length > 0 && scores.every((s) => s >= c.expect.min && s <= c.expect.max),
    spread: scores.length ? Math.max(...scores) - Math.min(...scores) : null,
    false_missing: ok.reduce((n, r) => n + r.false_missing.length, 0),
    keywords_total: ok.reduce((n, r) => n + r.keywords, 0),
    not_in_jd: ok.reduce((n, r) => n + r.not_in_jd.length, 0),
    generic_improvements: ok.reduce((n, r) => n + r.generic_improvements, 0),
    invented_originals: ok.reduce((n, r) => n + r.invented_originals, 0),
    rewrites_total: ok.reduce((n, r) => n + r.rewrites, 0),
    invented_numbers: ok.reduce((n, r) => n + r.invented_numbers, 0),
    errors: results.filter((r) => r.error).map((r) => r.error),
    runs: results,
  };
  report.cases.push(summary);
  console.log(`${c.id.padEnd(17)} scores ${JSON.stringify(scores).padEnd(10)} expect ${c.expect.min}-${c.expect.max} ${summary.in_range ? "✓" : "✗"}  `
    + `false-missing ${summary.false_missing}/${summary.keywords_total}  not-in-JD ${summary.not_in_jd}  `
    + `generic ${summary.generic_improvements}  invented-originals ${summary.invented_originals}/${summary.rewrites_total}  invented-numbers ${summary.invented_numbers}`
    + (summary.errors.length ? `  ERRORS: ${summary.errors.join(" | ")}` : ""));
}

const totals = report.cases.reduce((t, c) => ({
  in_range: t.in_range + (c.in_range ? 1 : 0),
  false_missing: t.false_missing + c.false_missing,
  keywords: t.keywords + c.keywords_total,
  not_in_jd: t.not_in_jd + c.not_in_jd,
  generic: t.generic + c.generic_improvements,
  invented: t.invented + c.invented_originals,
  rewrites: t.rewrites + c.rewrites_total,
  invented_numbers: t.invented_numbers + c.invented_numbers,
  errors: t.errors + c.errors.length,
  max_spread: Math.max(t.max_spread, c.spread ?? 0),
}), { in_range: 0, false_missing: 0, keywords: 0, not_in_jd: 0, generic: 0, invented: 0, rewrites: 0, invented_numbers: 0, errors: 0, max_spread: 0 });

const avg = (id) => {
  const s = report.cases.find((c) => c.id === id)?.scores || [];
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
};
const order = ["strong_fresher", "java_backend", "career_changer", "sparse_injection"];
totals.ranking_ok = order.every((id, i) => i === 0 || avg(order[i - 1]) > avg(id));
report.totals = totals;

console.log(`\n${version}: ${totals.in_range}/${report.cases.length} cases in expected range · `
  + `false-missing keywords ${totals.false_missing}/${totals.keywords} · keywords not in JD ${totals.not_in_jd} · `
  + `generic improvements ${totals.generic} · invented "before" lines ${totals.invented}/${totals.rewrites} · `
  + `invented numbers in rewrites ${totals.invented_numbers} · failed calls ${totals.errors} · `
  + `max score spread ${totals.max_spread} · ranking ${totals.ranking_ok ? "correct" : "WRONG"}`);

mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `${version}.json`), JSON.stringify(report, null, 2));
console.log(`Saved tests/results/${version}.json`);
