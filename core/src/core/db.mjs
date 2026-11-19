// 运行时无关的 SQLite 适配层。
// 插件里跑在 Bun（bun:sqlite），CLI/后台跑在 Node 24（node:sqlite）。
// 两者的 API 形状足够接近：exec / prepare / run / all / get / close。
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { DATA_DIR, DB_PATH } from "./config.mjs"

let Driver = null
let driverName = ""

export async function loadDriver() {
  if (Driver) return { Driver, driverName }
  try {
    const mod = await import("bun:sqlite")
    Driver = mod.Database
    driverName = "bun:sqlite"
    return { Driver, driverName }
  } catch {
    try {
      const mod = await import("node:sqlite")
      Driver = mod.DatabaseSync
      driverName = "node:sqlite"
      return { Driver, driverName }
    } catch (err) {
      throw new Error("no sqlite driver (need Bun or Node >= 22.5): " + err.message)
    }
  }
}

export async function openDb(path = DB_PATH) {
  const { Driver, driverName } = await loadDriver()
  mkdirSync(dirname(path), { recursive: true })
  const db = new Driver(path)
  // WAL 模式设置需要短暂排他锁；并发读（面板/注入）时可能失败，
  // 但数据库通常已经是 WAL，忽略即可。busy_timeout 必须先设。
  const pragma = (sql) => {
    try { db.exec(sql) } catch {}
  }
  pragma("PRAGMA busy_timeout=3000")
  pragma("PRAGMA journal_mode=WAL")
  pragma("PRAGMA journal_size_limit=16777216")
  pragma("PRAGMA auto_vacuum=INCREMENTAL")
  pragma("PRAGMA synchronous=NORMAL")
  pragma("PRAGMA foreign_keys=ON")
  return { db, driverName }
}

const SCHEMA_VERSION = 5

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS group_state (
  group_id         TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT NOT NULL DEFAULT 'user',
  source_memory_id TEXT,
  last_injected_at INTEGER,
  PRIMARY KEY (group_id, key)
);
CREATE INDEX IF NOT EXISTS idx_state_group ON group_state(group_id);

CREATE TABLE IF NOT EXISTS session_state (
  session_id       TEXT NOT NULL,
  group_id         TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            TEXT NOT NULL,
  updated_at       INTEGER NOT NULL,
  updated_by       TEXT NOT NULL DEFAULT 'summary',
  source_memory_id TEXT,
  last_injected_at INTEGER,
  PRIMARY KEY (session_id, key)
);
CREATE INDEX IF NOT EXISTS idx_session_state_group ON session_state(group_id, updated_at);

CREATE TABLE IF NOT EXISTS memory_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  paths_json TEXT,
  kind       TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  content      TEXT NOT NULL,
  detail       TEXT,
  source_json  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  confidence   REAL NOT NULL DEFAULT 0.5,
  hits         INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  last_used_at INTEGER,
  valid_from   INTEGER,
  valid_to     INTEGER,
  superseded_by TEXT,
  last_seen_at INTEGER,
  pinned       INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT,
  last_injected_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mem_group ON memories(group_id, status);
CREATE INDEX IF NOT EXISTS idx_mem_hash ON memories(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, detail, content='memories', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL,
  props_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

CREATE TABLE IF NOT EXISTS edges (
  src        TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  dst        TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (src, predicate, dst)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS memory_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT,
  group_id    TEXT,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  detail_json TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON memory_events(created_at);

CREATE TABLE IF NOT EXISTS event_rollups (
  group_id TEXT NOT NULL,
  action   TEXT NOT NULL,
  day      TEXT NOT NULL,
  n        INTEGER NOT NULL,
  PRIMARY KEY (group_id, action, day)
);
`

function hasColumn(db, table, name) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)
}

function ensureColumn(db, table, name, ddl) {
  if (!hasColumn(db, table, name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`)
}

export async function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get()
  const current = row?.user_version ?? 0
  if (current >= SCHEMA_VERSION) return { from: current, to: current, applied: false }
  db.exec("BEGIN")
  try {
    db.exec(SCHEMA)
    if (current < 4) {
      // v4：当前状态层。表已由 SCHEMA 建立；状态是覆盖写，历史仍在 memory_events。
    }
    if (current < 3) {
      // v3：时间有效性 + 置顶 + 最近命中
      ensureColumn(db, "memories", "valid_from", "INTEGER")
      ensureColumn(db, "memories", "valid_to", "INTEGER")
      ensureColumn(db, "memories", "superseded_by", "TEXT")
      ensureColumn(db, "memories", "last_seen_at", "INTEGER")
      ensureColumn(db, "memories", "pinned", "INTEGER NOT NULL DEFAULT 0")
      db.exec("CREATE INDEX IF NOT EXISTS idx_mem_valid ON memories(group_id, valid_to)")
      db.exec("UPDATE memories SET valid_from = created_at WHERE status='promoted' AND valid_from IS NULL")
      db.exec("UPDATE memories SET last_seen_at = updated_at WHERE last_seen_at IS NULL")
    }
    if (current < 5) {
      // v5：会话级状态 + 注入时间。
      ensureColumn(db, "memories", "session_id", "TEXT")
      ensureColumn(db, "memories", "last_injected_at", "INTEGER")
      ensureColumn(db, "group_state", "last_injected_at", "INTEGER")
      db.exec("CREATE INDEX IF NOT EXISTS idx_mem_session ON memories(group_id, session_id)")
      // 回填旧摘要的 session_id
      const summaries = db.prepare("SELECT id, source_json FROM memories WHERE session_id IS NULL AND source_json IS NOT NULL").all()
      const updSession = db.prepare("UPDATE memories SET session_id = ? WHERE id = ?")
      for (const r of summaries) {
        try {
          const sid = JSON.parse(r.source_json)?.session_id
          if (sid) updSession.run(String(sid), r.id)
        } catch {}
      }
      // 旧版摘要写的组级 next 迁到会话级；没有来源会话的直接丢弃，避免继续污染组
      const autos = db.prepare("SELECT * FROM group_state WHERE updated_by = 'summary'").all()
      const ins = db.prepare(
        `INSERT INTO session_state(session_id, group_id, key, value, updated_at, updated_by, source_memory_id, last_injected_at)
         VALUES(?,?,?,?,?,?,?,NULL)
         ON CONFLICT(session_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at,
           source_memory_id = excluded.source_memory_id`
      )
      const del = db.prepare("DELETE FROM group_state WHERE group_id = ? AND key = ?")
      for (const r of autos) {
        let sid = null
        if (r.source_memory_id) {
          const src = db.prepare("SELECT source_json FROM memories WHERE id = ?").get(r.source_memory_id)
          try { sid = JSON.parse(src?.source_json || "{}")?.session_id || null } catch {}
        }
        if (sid) ins.run(String(sid), r.group_id, r.key, r.value, r.updated_at, r.updated_by, r.source_memory_id)
        del.run(r.group_id, r.key)
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec("COMMIT")
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
  return { from: current, to: SCHEMA_VERSION, applied: true }
}

export function now() {
  return Date.now()
}

export function kvGet(db, key) {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key)
  return row ? row.value : null
}

export function kvSet(db, key, value) {
  db.prepare(
    "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value))
}

export function backupDb(db, destDir = join(DATA_DIR, "backups"), keep = 10) {
  mkdirSync(destDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dest = join(destDir, `mem-${stamp}.db`)
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  const files = readdirSync(destDir)
    .filter((f) => f.startsWith("mem-") && f.endsWith(".db"))
    .map((f) => ({ f, t: statSync(join(destDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const old of files.slice(keep)) {
    try { unlinkSync(join(destDir, old.f)) } catch {}
  }
  return { path: dest, size: statSync(dest).size, kept: Math.min(files.length, keep) }
}

export function dbStats(db) {
  const one = (sql) => db.prepare(sql).get()?.n ?? 0
  return {
    groups: one("SELECT COUNT(*) AS n FROM memory_groups"),
    memories: one("SELECT COUNT(*) AS n FROM memories"),
    promoted: one("SELECT COUNT(*) AS n FROM memories WHERE status='promoted' AND valid_to IS NULL"),
    drafts: one("SELECT COUNT(*) AS n FROM memories WHERE status='draft'"),
    conflicted: one("SELECT COUNT(*) AS n FROM memories WHERE status='conflicted'"),
    sessionStates: one("SELECT COUNT(*) AS n FROM session_state"),
    archived: one("SELECT COUNT(*) AS n FROM memories WHERE status='archived'"),
    entities: one("SELECT COUNT(*) AS n FROM entities"),
    edges: one("SELECT COUNT(*) AS n FROM edges"),
    events: one("SELECT COUNT(*) AS n FROM memory_events"),
  }
}

export { DATA_DIR, DB_PATH }
