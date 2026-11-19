// 记忆的状态流转与查询。纯函数，接收 db，便于测试与 CLI/HTTP 共用。
import { now } from "./db.mjs"

const TTL_DAYS = 7
const DAY = 86400_000

function event(db, memoryId, groupId, action, actor, detail) {
  db.prepare(
    "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
  ).run(memoryId, groupId || null, action, actor || "user", detail ? JSON.stringify(detail) : null, now())
}

function get(db, id) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id)
}

export function promoteMemory(db, id, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  const ts = now()
  db.prepare(
    `UPDATE memories SET status='promoted', expires_at=NULL, updated_at=?, last_seen_at=?,
       valid_from=COALESCE(valid_from, ?), valid_to=NULL, superseded_by=NULL WHERE id=?`
  ).run(ts, ts, ts, id)
  event(db, id, m.group_id, "promote", actor, { from: m.status })
  return true
}

export function demoteMemory(db, id, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  const ts = now()
  db.prepare(
    `UPDATE memories SET status='draft', expires_at=?, updated_at=?, valid_from=NULL,
       valid_to=NULL, superseded_by=NULL WHERE id=?`
  ).run(ts + TTL_DAYS * DAY, ts, id)
  event(db, id, m.group_id, "demote", actor, { from: m.status })
  return true
}

export function forgetMemory(db, id, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  const ts = now()
  // 归档保留历史：valid_to 标记失效时间，不物理删除
  db.prepare(
    "UPDATE memories SET status='archived', valid_to=COALESCE(valid_to, ?), updated_at=? WHERE id=?"
  ).run(ts, ts, id)
  event(db, id, m.group_id, "forget", actor, { from: m.status })
  return true
}

export function restoreMemory(db, id, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  const ts = now()
  db.prepare(
    `UPDATE memories SET status='draft', expires_at=?, updated_at=?, valid_from=NULL,
       valid_to=NULL, superseded_by=NULL WHERE id=?`
  ).run(ts + TTL_DAYS * DAY, ts, id)
  event(db, id, m.group_id, "restore", actor, { from: m.status })
  return true
}

export function supersedeMemory(db, oldId, newId, actor = "user") {
  if (oldId === newId) return false
  const older = get(db, oldId)
  const newer = get(db, newId)
  if (!older || !newer) return false
  const ts = now()
  db.prepare(
    `UPDATE memories SET status='promoted', expires_at=NULL, updated_at=?, last_seen_at=?,
       valid_from=COALESCE(valid_from, ?), valid_to=NULL, superseded_by=NULL WHERE id=?`
  ).run(ts, ts, ts, newId)
  db.prepare(
    "UPDATE memories SET status='archived', valid_to=?, superseded_by=?, updated_at=? WHERE id=?"
  ).run(ts, newId, ts, oldId)
  db.prepare(
    "INSERT INTO edges(src, predicate, dst, weight, created_at) VALUES(?,?,?,?,?) ON CONFLICT(src,predicate,dst) DO NOTHING"
  ).run(`memory:${newId}`, "supersedes", `memory:${oldId}`, 1, ts)
  event(db, newId, newer.group_id, "supersede", actor, { old: oldId })
  event(db, oldId, older.group_id, "superseded", actor, { by: newId })
  return true
}

export function pinMemory(db, id, pinned = true, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  db.prepare("UPDATE memories SET pinned=?, updated_at=? WHERE id=?").run(pinned ? 1 : 0, now(), id)
  event(db, id, m.group_id, pinned ? "pin" : "unpin", actor, {})
  return true
}

export function updateMemory(db, id, patch, actor = "user") {
  const m = get(db, id)
  if (!m) return false
  const content = patch.content !== undefined ? String(patch.content).slice(0, 300) : m.content
  const detail = patch.detail !== undefined ? String(patch.detail || "").slice(0, 2000) || null : m.detail
  const KINDS = ["decision", "pitfall", "progress", "summary", "reference", "preference", "procedure"]
  const kind = patch.kind && KINDS.includes(patch.kind) ? patch.kind : m.kind
  db.prepare("UPDATE memories SET content=?, detail=?, kind=?, updated_at=? WHERE id=?").run(content, detail, kind, now(), id)
  event(db, id, m.group_id, "edit", actor, { fields: Object.keys(patch) })
  return true
}

export function resolveConflict(db, keepId, dropId, actor = "user") {
  const keep = get(db, keepId)
  const drop = get(db, dropId)
  if (!keep || !drop) return false
  const ts = now()
  db.prepare(
    `UPDATE memories SET status='promoted', expires_at=NULL, updated_at=?, last_seen_at=?,
       valid_from=COALESCE(valid_from, ?), valid_to=NULL, superseded_by=NULL WHERE id=?`
  ).run(ts, ts, ts, keepId)
  db.prepare("UPDATE memories SET status='archived', valid_to=COALESCE(valid_to, ?), updated_at=? WHERE id=?").run(ts, ts, dropId)
  db.prepare(
    "DELETE FROM edges WHERE predicate='conflicts' AND ((src=? AND dst=?) OR (src=? AND dst=?))"
  ).run(`memory:${keepId}`, `memory:${dropId}`, `memory:${dropId}`, `memory:${keepId}`)
  event(db, keepId, keep.group_id, "resolve", actor, { keep: keepId, drop: dropId })
  event(db, dropId, drop.group_id, "resolve_dropped", actor, { keep: keepId })
  return true
}

export function getMemory(db, id) {
  const m = get(db, id)
  if (!m) return null
  const events = db.prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY id DESC LIMIT 20").all(id)
  return { ...m, events }
}

export function listMemories(db, { groupID, status, kind, query, limit = 50, offset = 0, sort = "updated" } = {}) {
  const where = []
  const args = []
  if (groupID) { where.push("m.group_id = ?"); args.push(groupID) }
  if (status) { where.push("m.status = ?"); args.push(status) }
  if (kind) { where.push("m.kind = ?"); args.push(kind) }
  if (query) {
    where.push("m.id IN (SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?)")
    args.push(query)
  }
  const order = {
    confidence: "m.pinned DESC, m.confidence DESC, m.updated_at DESC",
    hits: "m.pinned DESC, m.hits DESC, m.updated_at DESC",
    created: "m.pinned DESC, m.created_at DESC",
  }[sort] || "m.pinned DESC, m.updated_at DESC"
  const sql = `SELECT m.* FROM memories m ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY ${order} LIMIT ? OFFSET ?`
  const rows = db.prepare(sql).all(...args, limit, offset)
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM memories m ${where.length ? "WHERE " + where.join(" AND ") : ""}`)
    .get(...args)?.n ?? 0
  return Object.assign(rows, { total })
}

export function groupStats(db, groupID) {
  return db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='promoted' THEN 1 ELSE 0 END) AS promoted,
         SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts,
         SUM(CASE WHEN status='conflicted' THEN 1 ELSE 0 END) AS conflicted,
         SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END) AS archived
       FROM memories WHERE group_id = ?`
    )
    .get(groupID)
}
