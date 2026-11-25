// Local development server: `npm run dev`, then open http://localhost:3000
// Serves the static site and runs api/analyze.js the same way Vercel does.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./lib/env.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Only these top-level paths are served, like the public files on Vercel.
const PUBLIC = new Set(["index.html", "styles.css", "app.js", "favicon.svg"]);

// Give the Node response the small helpers Vercel adds.
function vercelShim(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

loadEnv(join(ROOT, ".env.local"));
const API_ROUTES = {
  "/api/analyze": (await import("./api/analyze.js")).default,
  "/api/generate": (await import("./api/generate.js")).default,
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const route = API_ROUTES[url.pathname];
  if (route) {
    req.body = req.method === "POST" ? await readBody(req) : undefined;
    return route(req, vercelShim(res));
  }

  const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = normalize(join(ROOT, name));
  if (!PUBLIC.has(name) || !file.startsWith(ROOT + sep)) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  try {
    const content = await readFile(file);
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
}).listen(PORT, () => {
  const keyStatus = process.env.GEMINI_API_KEY ? "found" : "MISSING — paste it into .env.local";
  console.log(`Resumex running at http://localhost:${PORT}  (Gemini key: ${keyStatus})`);
});
