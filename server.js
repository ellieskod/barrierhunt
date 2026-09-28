// Barrier hunt: in-memory live photo wall. No dependencies, no database.
// Everything is lost when the server restarts.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "asecretkey";
const MAX_POSTS = 300;
const MAX_BODY = 8 * 1024 * 1024;
const TAGS = ["ignorance", "profit", "normative"];

let posts = [];            // newest last
const images = new Map();  // id -> { buf, type }
let version = 0;
const clients = new Set();

const INDEX = fs.readFileSync(path.join(__dirname, "index.html"));

function bump() {
  version++;
  for (const res of clients) res.write(`data: ${version}\n\n`);
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function clean(s, max) {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}
function isAdmin(url) {
  return ADMIN_KEY && url.searchParams.get("key") === ADMIN_KEY;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad_json")); }
    });
    req.on("error", reject);
  });
}
function publicPost(p) {
  return {
    id: p.id, createdAt: p.createdAt, alt: p.alt, where: p.where, name: p.name,
    tags: p.tags, comments: p.comments
  };
}


const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(INDEX);
    }

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(`data: ${version}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/posts") {
      return send(res, 200, { version, posts: posts.slice().reverse().map(publicPost) });
    }

    if (req.method === "GET" && parts[0] === "img" && parts[1]) {
      const img = images.get(parts[1]);
      if (!img) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": img.type, "Cache-Control": "public, max-age=86400" });
      return res.end(img.buf);
    }

    if (req.method === "GET" && (url.pathname.endsWith(".css") || url.pathname.endsWith(".js") || url.pathname.endsWith(".json"))) {
      const filePath = path.join(__dirname, "public", url.pathname);
      if (!filePath.startsWith(path.join(__dirname, "public"))) { res.writeHead(404); return res.end(); }
      try {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath);
        const types = { ".css": "text/css", ".js": "application/javascript", ".json": "application/json" };
        res.writeHead(200, { "Content-Type": types[ext] || "text/plain", "Cache-Control": "public, max-age=3600" });
        return res.end(content);
      } catch { res.writeHead(404); return res.end(); }
    }

    if (req.method === "POST" && url.pathname === "/api/posts") {
      const b = await readBody(req);
      const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(b.image || "");
      const alt = clean(b.alt, 400);
      const where = clean(b.where, 300);
      if (!m) return send(res, 400, { error: "Add a photo (JPEG, PNG or WebP)." });
      if (!alt) return send(res, 400, { error: "Write alt text for the photo." });
      if (!where) return send(res, 400, { error: "Describe the barrier and where it is." });
      const id = crypto.randomBytes(6).toString("hex");
      images.set(id, { buf: Buffer.from(m[2], "base64"), type: m[1] });
      const tags = { ignorance: 0, profit: 0, normative: 0 };
      (Array.isArray(b.tags) ? b.tags : []).forEach(t => { if (TAGS.includes(t)) tags[t] = 1; });
      const comments = [];
      const fix = clean(b.fix, 500);
      const name = clean(b.name, 40);
      if (fix) comments.push({ id: crypto.randomBytes(4).toString("hex"), kind: "fix", text: fix, name, createdAt: Date.now() });
      posts.push({ id, createdAt: Date.now(), alt, where, name, tags, comments });
      while (posts.length > MAX_POSTS) images.delete(posts.shift().id);
      bump();
      return send(res, 201, { id });
    }

    if (req.method === "POST" && parts[0] === "api" && parts[1] === "posts" && parts[2]) {
      const p = posts.find(x => x.id === parts[2]);
      if (!p) return send(res, 404, { error: "That photo is no longer on the wall." });
      const b = await readBody(req);

      if (parts[3] === "comments") {
        const text = clean(b.text, 500);
        if (!text) return send(res, 400, { error: "Write something first." });
        const kind = b.kind === "fix" ? "fix" : "comment";
        p.comments.push({ id: crypto.randomBytes(4).toString("hex"), kind, text, name: clean(b.name, 40), createdAt: Date.now() });
        if (p.comments.length > 200) p.comments.shift();
        bump();
        return send(res, 201, { ok: true });
      }
      if (parts[3] === "vote") {
        if (!TAGS.includes(b.tag)) return send(res, 400, { error: "Unknown reason." });
        const d = b.delta === -1 ? -1 : 1;
        p.tags[b.tag] = Math.max(0, p.tags[b.tag] + d);
        bump();
        return send(res, 200, { ok: true });
      }
    }

    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "posts" && parts[2]) {
      if (!isAdmin(url)) return send(res, 403, { error: "Admin key required." });
      if (parts[3] === "comments" && parts[4]) {
        const p = posts.find(x => x.id === parts[2]);
        if (p) p.comments = p.comments.filter(c => c.id !== parts[4]);
      } else {
        posts = posts.filter(x => x.id !== parts[2]);
        images.delete(parts[2]);
      }
      bump();
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      if (!isAdmin(url)) return send(res, 403, { error: "Admin key required." });
      posts = []; images.clear(); bump();
      return send(res, 200, { ok: true });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    if (e.message === "too_large") return send(res, 413, { error: "Photo is too large." });
    if (e.message === "bad_json") return send(res, 400, { error: "Bad request." });
    console.error(e);
    send(res, 500, { error: "Something went wrong on the server." });
  }
});

// keep SSE connections alive through proxies
setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 25000);

server.listen(PORT, () => console.log(`Barrier hunt on :${PORT}`));
