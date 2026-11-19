// 路径、配置、记忆组解析。插件与 CLI 共用。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

export const DATA_DIR = process.env.AGENT_MEMORY_DIR || join(homedir(), ".agent-memory")
export const DB_PATH = join(DATA_DIR, "mem.db")
export const CONFIG_PATH = join(DATA_DIR, "config.json")
export const GROUPS_PATH = join(DATA_DIR, "groups.json")
export const HEARTBEAT_PATH = join(DATA_DIR, "plugin-heartbeat.json")
export const LOG_PATH = join(DATA_DIR, "plugin.log")

export const DEFAULT_CONFIG = {
  ui: { host: "127.0.0.1", port: 4780, autoStart: false },
  capture: {
    enabled: true,
    maxMessages: 40,
    // 宿主不发 execution 事件时，按「会话事件静默 N 毫秒」兜底捕获
    idleFallbackMs: 180_000,
    consolidateTimeoutMs: 75_000,
    providerID: "owner",
    modelID: "deepseek-v4.1-flash",
    // 默认关闭：草稿仍需人工晋升；显式开启后只自动晋升高置信度的决策/偏好/做法
    autoPromote: { enabled: false, minConfidence: 0.9, kinds: ["decision", "preference", "procedure"] },
  },
  retrieval: { budgetChars: 1400, globalLimit: 6, groupLimit: 10, minConfidence: 0.45 },
  draft: { ttlDays: 7, maxPerGroup: 200, progressTtlDays: 3 },
  promoted: { maxPerGroup: 3000 },
  state: { sessionTtlDays: 90 },
  events: { keepDays: 90 },
  budget: { softMb: 200, hardMb: 500 },
}

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true })
}

export function loadConfig() {
  ensureDataDir()
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8")
    return structuredClone(DEFAULT_CONFIG)
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw)
  } catch {
    return structuredClone(DEFAULT_CONFIG)
  }
}

export function saveConfig(cfg) {
  ensureDataDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

function deepMerge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object") {
      base[k] = deepMerge(base[k], v)
    } else {
      base[k] = v
    }
  }
  return base
}

export function loadGroups() {
  ensureDataDir()
  if (!existsSync(GROUPS_PATH)) {
    const example = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "groups.example.json")
    if (existsSync(example)) {
      writeFileSync(GROUPS_PATH, readFileSync(example, "utf8"), "utf8")
      return JSON.parse(readFileSync(GROUPS_PATH, "utf8"))
    }
    const seed = { groups: [] }
    writeFileSync(GROUPS_PATH, JSON.stringify(seed, null, 2) + "\n", "utf8")
    return seed
  }
  try {
    const parsed = JSON.parse(readFileSync(GROUPS_PATH, "utf8"))
    return Array.isArray(parsed.groups) ? parsed : { groups: [] }
  } catch (err) {
    throw new Error(`groups.json 解析失败: ${err.message}`)
  }
}

export function normalizeDir(dir) {
  let d = String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "")
  if (process.platform === "win32") d = d.toLowerCase()
  return d
}

// 只支持 * / ** / ? 三种通配，够用且不会引入依赖。
export function patternToRegex(pattern) {
  const p = normalizeDir(pattern)
  const recursive = p.endsWith("/**")
  const body = recursive ? p.slice(0, -3) : p
  let out = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "*") {
      if (body[i + 1] === "*") {
        out += ".*"
        i++
      } else {
        out += "[^/]*"
      }
    } else if (ch === "?") {
      out += "[^/]"
    } else if (".+^${}()|[]\\".includes(ch)) {
      out += "\\" + ch
    } else {
      out += ch
    }
  }
  return recursive ? new RegExp("^" + out + "($|/.*)") : new RegExp("^" + out + "(/|$)")
}

export function resolveGroup(dir, groupsFile = loadGroups()) {
  const target = normalizeDir(dir)
  let best = null
  for (const g of groupsFile.groups || []) {
    for (const pattern of g.paths || []) {
      if (!patternToRegex(pattern).test(target)) continue
      const score = normalizeDir(pattern).replace(/\*+/g, "").length
      if (!best || score > best.score) {
        best = { id: g.id, name: g.name || g.id, kind: "manual", pattern, score }
      }
    }
  }
  if (best) return best
  const hash = createHash("sha1").update(target).digest("hex").slice(0, 12)
  return {
    id: `p:${hash}`,
    name: basename(target) || target,
    kind: "auto",
    pattern: null,
    score: 0,
  }
}

export function ensureGroup(db, group) {
  const now = Date.now()
  const existing = db.prepare("SELECT id FROM memory_groups WHERE id = ?").get(group.id)
  if (existing) return
  db.prepare(
    "INSERT INTO memory_groups(id, name, paths_json, kind, created_at) VALUES(?,?,?,?,?)"
  ).run(group.id, group.name, group.pattern ? JSON.stringify([group.pattern]) : null, group.kind, now)
  db.prepare(
    "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
  ).run(null, group.id, "group_create", "system", JSON.stringify({ name: group.name }), now)
}

export function readHeartbeat() {
  try {
    return JSON.parse(readFileSync(HEARTBEAT_PATH, "utf8"))
  } catch {
    return null
  }
}

export function writeHeartbeat(data) {
  ensureDataDir()
  writeFileSync(HEARTBEAT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8")
}

export function appendLog(line) {
  try {
    ensureDataDir()
    writeFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, { flag: "a" })
  } catch {
    /* 日志失败不影响宿主 */
  }
}
