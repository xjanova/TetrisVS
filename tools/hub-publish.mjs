#!/usr/bin/env node
/**
 * Package this game for XMAN GAMES HUB (https://xgameshub.xman4289.com/play/<id>/).
 *
 *   node tools/hub-publish.mjs <outDir>
 *   env GAME_ID   hub id (play/<GAME_ID>/), required
 *       VERSION   e.g. v1.0.12 (default: "dev")
 *
 * Optional hub.json next to DEVLOG.md:
 *   { "root": "packages/client/dist", "ship": ["index.html", "assets"] }
 *   root = folder the shipped files are taken from (default: repo root)
 *   ship = files/folders to copy (default: index.html, manifest, css, js, assets)
 * A package.json script "hub:build" is run by the workflow before packaging.
 *
 * - copies what the browser loads (index.html, manifest, css, js, assets) into <outDir>
 * - turns DEVLOG.md into <outDir>/devlog.json — the hub reads it to show this
 *   game's version and development notes
 * - refuses to ship the name of the code-hosting service anywhere a visitor
 *   could read it (owner rule: customers never see where the code lives)
 *
 * No dependencies; Node 18+.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(process.argv[2] || "dist");
const ROOT = process.cwd();
const GAME_ID = process.env.GAME_ID;
const VERSION = process.env.VERSION || "dev";
const DEFAULT_SHIP = ["index.html", "manifest.webmanifest", "css", "js", "assets"];
const SKIP = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const TEXT = /\.(html|js|mjs|css|json|webmanifest|txt|svg)$/i;

if (!GAME_ID || !/^[a-z0-9-]+$/.test(GAME_ID)) {
  console.error("GAME_ID is required (lower-case letters, digits, dashes)");
  process.exit(1);
}

const exists = (p) => stat(p).then(() => true, () => false);

const cfg = (await exists(path.join(ROOT, "hub.json")))
  ? JSON.parse(await readFile(path.join(ROOT, "hub.json"), "utf8"))
  : {};
const FROM = path.resolve(ROOT, cfg.root || ".");
const SHIP = Array.isArray(cfg.ship) && cfg.ship.length ? cfg.ship : DEFAULT_SHIP;

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** DEVLOG.md -> { name, summary, status, entries[], roadmap[] } */
function parseDevlog(md) {
  const out = { name: "", summary: "", status: "", entries: [], roadmap: [] };
  let cur = null;
  let inRoadmap = false;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^#\s+(.+)$/))) {
      out.name = m[1].replace(/\s+[—-]\s+บันทึกการพัฒนา.*$/, "").trim();
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      out.summary = (out.summary + " " + m[1]).trim();
    } else if ((m = line.match(/^\*\*สถานะ:\*\*\s*(.+)$/))) {
      out.status = m[1].trim();
    } else if ((m = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s*[—-]?\s*(.*)$/))) {
      cur = { date: m[1], title: m[2].trim(), items: [] };
      out.entries.push(cur);
      inRoadmap = false;
    } else if (/^##\s+แผนต่อไป/.test(line)) {
      cur = null;
      inRoadmap = true;
    } else if (/^##\s+/.test(line)) {
      cur = null;
      inRoadmap = false;
    } else if ((m = line.match(/^\s*[-*]\s+(.+)$/))) {
      const text = m[1].replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
      if (inRoadmap) out.roadmap.push(text);
      else if (cur) cur.items.push(text);
    }
  }
  out.entries.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

// spelled in two parts so this file itself never contains the word it bans
const BANNED = new RegExp("git" + "hub", "i");
const problems = [];
const forbid = (where, text) => {
  if (BANNED.test(text)) problems.push(where);
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let files = 0;
let bytes = 0;
for (const item of SHIP) {
  const src = path.join(FROM, item);
  if (!(await exists(src))) continue;
  await cp(src, path.join(OUT, item), {
    recursive: true,
    filter: (p) => !SKIP.has(path.basename(p)) && !p.endsWith(".py"),
  });
}
for await (const f of walk(OUT)) {
  files++;
  bytes += (await stat(f)).size;
  if (TEXT.test(f)) forbid(path.relative(OUT, f), await readFile(f, "utf8"));
}
if (!(await exists(path.join(OUT, "index.html")))) {
  console.error("index.html missing — nothing to publish");
  process.exit(1);
}

const mdPath = path.join(ROOT, "DEVLOG.md");
const md = (await exists(mdPath)) ? await readFile(mdPath, "utf8") : "";
forbid("DEVLOG.md", md);
const log = parseDevlog(md);
const devlog = {
  id: GAME_ID,
  name: log.name || GAME_ID,
  version: VERSION,
  built: new Date().toISOString(),
  url: `/play/${GAME_ID}/`,
  summary: log.summary,
  status: log.status,
  entries: log.entries,
  roadmap: log.roadmap,
  size: { files, mb: Math.round((bytes / 1048576) * 10) / 10 },
};
await writeFile(path.join(OUT, "devlog.json"), JSON.stringify(devlog, null, 2));

if (problems.length) {
  console.error(["refusing to publish: the code host's name is visible in", ...problems].join("\n  "));
  process.exit(1);
}
console.log(`packaged ${GAME_ID} ${VERSION}: ${files} files, ${devlog.size.mb} MB, ${log.entries.length} devlog entries`);
