// 当前状态层：组级（人写，所有会话共享）+ 会话级（摘要自动写，只影响该会话）。
// 状态是“现在是什么”，记忆是“发生过什么”。
import { now } from "./db.mjs"

const DAY = 86400_000
const LIMIT_KEY = 40
const LIMIT_VALUE = 400

export const STATE_LABELS = {
  status: "状态",
  next: "下一步",
  blocker: "阻塞",
  focus: "焦点",
}

const MANUAL_ACTORS = ["user", "panel", "cli"]

function ageLabel(ts, tsNow = Date.now()) {
  if (!ts) return "未知"
  const d = Math.max(0, tsNow - ts)
  if (d < 60_000) return "刚刚"
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < DAY) return `${Math.round(d / 3_600_000)} 小时前`
  if (d < 30 * DAY) return `${Math.round(d / DAY)} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function event(db, groupID, key, action, by, detail) {
  db.prepare(
    "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
  ).run(null, groupID, action, by || "user", JSON.stringify({ key, ...(detail || {}) }), now())
}

export function setState(db, groupID, key, value, { by = "user", sourceId = null } = {}) {
  const k = String(key || "").trim().slice(0, LIMIT_KEY)
  if (!groupID || !k) return false
  const v = String(value ?? "").trim().slice(0, LIMIT_VALUE)
  const ts = now()
  if (!v) {
    const r = db.prepare("DELETE FROM group_state WHERE group_id = ? AND key = ?").run(groupID, k)
    if (r.changes) event(db, groupID, k, "state_clear", by, { scope: "group" })
    return true
  }
  db.prepare(
    `INSERT INTO group_state(group_id, key, value, updated_at, updated_by, source_memory_id, last_injected_at)
     VALUES(?,?,?,?,?,?,NULL)
     ON CONFLICT(group_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       source_memory_id = excluded.source_memory_id,
       last_injected_at = NULL`
  ).run(groupID, k, v, ts, by, sourceId)
  event(db, groupID, k, "state_set", by, { source: sourceId, scope: "group" })
  return true
}

export function setSessionState(
  db,
  groupID,
  sessionID,
  key,
  value,
  { by = "summary", sourceId = null } = {}
) {
  const k = String(key || "").trim().slice(0, LIMIT_KEY)
  if (!groupID || !sessionID || !k) return false
  const v = String(value ?? "").trim().slice(0, LIMIT_VALUE)
  const ts = now()
  if (!v) {
    const r = db.prepare("DELETE FROM session_state WHERE session_id = ? AND key = ?").run(sessionID, k)
    if (r.changes) event(db, groupID, k, "state_clear", by, { scope: "session", session_id: sessionID })
    return true
  }
  db.prepare(
    `INSERT INTO session_state(session_id, group_id, key, value, updated_at, updated_by, source_memory_id, last_injected_at)
     VALUES(?,?,?,?,?,?,?,NULL)
     ON CONFLICT(session_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by,
       source_memory_id = excluded.source_memory_id,
       last_injected_at = NULL`
  ).run(sessionID, groupID, k, v, ts, by, sourceId)
  event(db, groupID, k, "state_set", by, {
    source: sourceId,
    scope: "session",
    session_id: sessionID,
  })
  return true
}

export function getState(db, groupID) {
  if (!groupID || groupID === "global") return []
  return db
    .prepare(
      `SELECT key, value, updated_at, updated_by, source_memory_id, last_injected_at
       FROM group_state WHERE group_id = ?
       ORDER BY CASE key WHEN 'status' THEN 0 WHEN 'next' THEN 1 WHEN 'blocker' THEN 2 ELSE 3 END,
                updated_at DESC`
    )
    .all(groupID)
}

export function getSessionState(db, sessionID) {
  if (!sessionID) return []
  return db
    .prepare(
      `SELECT key, value, updated_at, updated_by, source_memory_id, last_injected_at
       FROM session_state WHERE session_id = ?
       ORDER BY CASE key WHEN 'status' THEN 0 WHEN 'next' THEN 1 WHEN 'blocker' THEN 2 ELSE 3 END,
                updated_at DESC`
    )
    .all(sessionID)
}

// 注入用：当前会话有会话级状态就只用它；否则用组级里人写的状态。
// 摘要自动写的组级状态不会回退注入，避免跨任务污染。
export function getStateForContext(db, groupID, sessionID) {
  if (sessionID) {
    const rows = getSessionState(db, sessionID)
    if (rows.length) return { scope: "session", rows, sessionID, groupID }
  }
  const rows = db
    .prepare(
      `SELECT key, value, updated_at, updated_by, source_memory_id, last_injected_at
       FROM group_state
       WHERE group_id = ? AND updated_by IN (${MANUAL_ACTORS.map(() => "?").join(",")})
       ORDER BY CASE key WHEN 'status' THEN 0 WHEN 'next' THEN 1 WHEN 'blocker' THEN 2 ELSE 3 END,
                updated_at DESC`
    )
    .all(groupID, ...MANUAL_ACTORS)
  return { scope: "group", rows, groupID }
}

export function formatState(rows, tsNow = Date.now(), scope = "group") {
  if (!rows || !rows.length) return ""
  const newest = Math.max(...rows.map((r) => r.updated_at || 0))
  const lines = rows.map((r) => `- ${STATE_LABELS[r.key] || r.key}：${r.value}`)
  const label = scope === "session" ? "当前会话状态" : "组状态"
  return `${label}（更新于 ${ageLabel(newest, tsNow)}）：\n${lines.join("\n")}`
}

export function touchStateInjected(db, state, tsNow = Date.now()) {
  if (!state || !state.rows?.length) return
  const keys = state.rows.map((r) => r.key)
  const marks = keys.map(() => "?").join(",")
  if (state.scope === "session" && state.sessionID) {
    db.prepare(
      `UPDATE session_state SET last_injected_at = ? WHERE session_id = ? AND key IN (${marks})`
    ).run(tsNow, state.sessionID, ...keys)
  } else {
    db.prepare(
      `UPDATE group_state SET last_injected_at = ? WHERE group_id = ? AND updated_by IN ('user','panel','cli') AND key IN (${marks})`
    ).run(tsNow, state.groupID || "", ...keys)
  }
}

// 会话摘要里的 next_steps 覆盖该会话的“下一步”；不碰组级状态。
export function applySummaryState(db, groupID, summary, sourceId, sessionID) {
  const next = String(summary?.next_steps || "").trim()
  if (!next || !sessionID) return false
  return setSessionState(db, groupID, sessionID, "next", next.slice(0, 300), {
    by: "summary",
    sourceId,
  })
}

export function listSessionStates(db, groupID, limit = 8) {
  if (!groupID || groupID === "global") return []
  const scopes = db
    .prepare(
      `SELECT session_id, MAX(updated_at) AS updated_at, MAX(last_injected_at) AS last_injected_at
       FROM session_state WHERE group_id = ?
       GROUP BY session_id ORDER BY updated_at DESC LIMIT ?`
    )
    .all(groupID, limit)
  return scopes.map((s) => ({
    ...s,
    rows: getSessionState(db, s.session_id),
  }))
}

export function pruneSessionStates(db, days, tsNow = Date.now()) {
  if (!(days > 0)) return 0
  const r = db.prepare("DELETE FROM session_state WHERE updated_at < ?").run(tsNow - days * DAY)
  return r.changes || 0
}
