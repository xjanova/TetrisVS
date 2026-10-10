#!/usr/bin/env node
/**
 * Package this game for XMAN GAMES HUB (https://xmangameshub.online/play/<id>/).
 *
 *   node tools/hub-publish.mjs <outDir>
 *   env GAME_ID   hub id (play/<GAME_ID>/), required
 *       VERSION   e.g. v1.0.12 (default: "dev")
 *
 * Optional hub.json next to DEVLOG.md:
 *   { "root": "packages/client/dist", "ship": ["index.html", "assets"], "devlogHide": ["..."] }
 *   root = folder the shipped files are taken from (default: repo root)
 *   ship = files/folders to copy (default: index.html, manifest, css, js, assets)
 *   devlogHide = exact Devlog lines to leave out (a commit cannot be edited once pushed)
 *   devlogOnly = true for games that are not played in the browser (e.g. a
 *     Roblox experience): only devlog.json is published, the hub links out
 * A package.json script "hub:build" is run by the workflow before packaging.
 *
 * - copies what the browser loads (index.html, manifest, css, js, assets) into <outDir>
 * - turns DEVLOG.md into <outDir>/devlog.json — the hub reads it to show this
 *   game's version and development notes
 * - adds the "Devlog: <Thai text>" lines of commit message bodies to those notes,
 *   under the commit's day (Asia/Bangkok), so the timeline keeps up with every
 *   deploy. Commits without one stay off the timeline. History is read from the
 *   repo this file lives in and must be complete (checkout with fetch-depth: 0).
 *   DEVLOG.md keeps the summary, status and plans.
 * - refuses to ship the name of the code-hosting service anywhere a visitor
 *   could read it (owner rule: customers never see where the code lives)
 *
 * No dependencies; Node 18+.
 */
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const DEVLOG_ONLY = cfg.devlogOnly === true;
const SHIP = DEVLOG_ONLY ? [] : Array.isArray(cfg.ship) && cfg.ship.length ? cfg.ship : DEFAULT_SHIP;

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
      const text = plain(m[1]);
      if (inRoadmap) out.roadmap.push(text);
      else if (cur) cur.items.push(text);
    }
  }
  out.entries.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
const same = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
// Bangkok is UTC+7 all year (no daylight saving), so this is exact on any machine
const bangkokDay = (ms) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
const EMAIL = /[^\s<>()[\]]+@[^\s<>()[\]]+\.[a-z]{2,}/gi;
const THAI = /[฀-๿]/;

// spelled in two parts so this file itself never contains the word it bans
const BANNED = new RegExp("git" + "hub", "i");
const problems = [];
const forbid = (where, text) => {
  if (BANNED.test(text)) problems.push(where);
};
const warnings = [];

/** "Devlog: ..." body lines of every commit, oldest first -> [{ date, text }] */
function commitNotes() {
  // the repo this tool lives in, even when it runs from a staging folder (e.g. a devlog-only deploy script)
  const repo = path.dirname(fileURLToPath(import.meta.url));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  let log;
  try {
    if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
      warnings.push("shallow clone: Devlog lines of older commits are missing (checkout needs fetch-depth: 0)");
    }
    log = git("log", "--reverse", "-i", "--grep=devlog", "--format=%cI%x1f%b%x1e");
  } catch {
    warnings.push("no git history here: Devlog lines skipped");
    return [];
  }
  const notes = [];
  for (const rec of log.split("\x1e")) {
    const [when, body = ""] = rec.trimStart().split("\x1f");
    const ms = Date.parse(when);
    if (!ms) continue;
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:[-*]\s+)?devlog\s*:\s*(.+)$/i);
      if (!m) continue;
      const text = plain(m[1].replace(EMAIL, "").replace(/<\s*>|\(\s*\)|\[\s*\]/g, "")).replace(/\s{2,}/g, " ");
      // the line is player-facing: a bad one is left out, because history cannot be fixed
      if (BANNED.test(text)) warnings.push(`Devlog line of ${when} names the code host — left out`);
      else if (!THAI.test(text)) warnings.push(`Devlog line of ${when} has no Thai — left out: ${text}`);
      else notes.push({ date: bangkokDay(ms), text });
    }
  }
  return notes;
}

/** Adds commit notes to the DEVLOG.md entries: same day → appended, new day → its own entry. */
function addNotes(entries, notes, hide) {
  let added = 0;
  const seen = new Set([...hide, ...entries.flatMap((e) => [e.title, ...e.items])].map(same));
  for (const { date, text } of notes) {
    if (seen.has(same(text))) continue;
    seen.add(same(text));
    const day = entries.find((e) => e.date === date);
    if (day) day.items.push(text);
    else entries.push({ date, title: text, items: [] });
    added++;
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return added;
}

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
if (!DEVLOG_ONLY && !(await exists(path.join(OUT, "index.html")))) {
  console.error("index.html missing — nothing to publish");
  process.exit(1);
}

const mdPath = path.join(ROOT, "DEVLOG.md");
const md = (await exists(mdPath)) ? await readFile(mdPath, "utf8") : "";
forbid("DEVLOG.md", md);
const log = parseDevlog(md);
const hide = Array.isArray(cfg.devlogHide) ? cfg.devlogHide.filter((s) => typeof s === "string") : [];
const fromCommits = addNotes(log.entries, commitNotes(), hide);
const now = new Date();
const devlog = {
  id: GAME_ID,
  name: log.name || GAME_ID,
  version: VERSION,
  built: now.toISOString(),
  updated: bangkokDay(now.getTime()),
  url: `/play/${GAME_ID}/`,
  summary: log.summary,
  status: log.status,
  entries: log.entries,
  roadmap: log.roadmap,
  size: { files, mb: Math.round((bytes / 1048576) * 10) / 10 },
};
const json = JSON.stringify(devlog, null, 2);
forbid("devlog.json", json);
await writeFile(path.join(OUT, "devlog.json"), json);

for (const w of warnings) console.log(`::warning::${w}`);
if (problems.length) {
  console.error(["refusing to publish: the code host's name is visible in", ...problems].join("\n  "));
  process.exit(1);
}
console.log(
  `packaged ${GAME_ID} ${VERSION}: ${files} files, ${devlog.size.mb} MB, ` +
    `${log.entries.length} devlog entries (${fromCommits} lines from commits)`,
);
