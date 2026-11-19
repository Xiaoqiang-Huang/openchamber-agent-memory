// 会话摘要：一次会话一条，覆盖写同一会话的旧摘要。
// 摘要不是候选记忆，不参与相似度冲突；它是“上次到哪了”的当前结论。
import { createHash } from "node:crypto"
import { now } from "../core/db.mjs"
import { applySummaryState } from "../core/state.mjs"

const FIELDS = ["request", "investigated", "learned", "completed", "next_steps", "notes"]
const LABELS = {
  request: "请求",
  investigated: "调查",
  learned: "学到",
  completed: "完成",
  next_steps: "下一步",
  notes: "备注",
}

export function normalizeSummary(raw) {
  if (!raw || typeof raw !== "object") return null
  const out = {}
  let any = false
  for (const key of FIELDS) {
    const value = String(raw[key] ?? "").replace(/\s+/g, " ").trim().slice(0, 600)
    out[key] = value
    if (value) any = true
  }
  return any ? out : null
}

export function summaryContent(s) {
  const primary = s.completed || s.learned || s.investigated || s.request || ""
  if (!primary) return ""
  const next = s.next_steps && !primary.includes(s.next_steps) ? `；下一步：${s.next_steps}` : ""
  return (primary + next).slice(0, 300)
}

function summaryDetail(s) {
  return FIELDS.filter((k) => s[k])
    .map((k) => `${LABELS[k]}：${s[k]}`)
    .join("\n")
    .slice(0, 2000)
}

export function saveSessionSummary(db, { group, dir, sessionID, summary, actor = "plugin" }) {
  const s = normalizeSummary(summary)
  if (!s) return null
  const content = summaryContent(s)
  if (!content) return null
  const groupID = group.id
  const ts = now()
  const id =
    "s_" +
    createHash("sha1")
      .update(`${groupID}:${sessionID || ts}`)
      .digest("hex")
      .slice(0, 16)
  const detail = summaryDetail(s)
  const source = JSON.stringify({
    session_id: sessionID || null,
    dir: dir || null,
    summary: s,
  })
  const existing = db.prepare("SELECT id FROM memories WHERE id = ?").get(id)
  if (existing) {
    db.prepare(
      `UPDATE memories SET content=?, detail=?, source_json=?, status='promoted',
         expires_at=NULL, valid_to=NULL, superseded_by=NULL, updated_at=?, last_seen_at=?,
         session_id=?, last_injected_at=NULL
       WHERE id=?`
    ).run(content, detail, source, ts, ts, sessionID || null, id)
    db.prepare(
      "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
    ).run(id, groupID, "summary_update", actor, JSON.stringify({ fields: FIELDS.filter((k) => s[k]) }), ts)
  } else {
    db.prepare(
      `INSERT INTO memories(id, group_id, kind, status, content, detail, source_json, content_hash,
                            confidence, hits, created_at, updated_at, expires_at, last_used_at,
                            valid_from, valid_to, superseded_by, last_seen_at, pinned,
                            session_id, last_injected_at)
       VALUES(?,?,?,?,?,?,?,?,?,0,?,?,NULL,NULL,?,NULL,NULL,?,0,?,NULL)`
    ).run(
      id,
      groupID,
      "summary",
      "promoted",
      content,
      detail,
      source,
      createHash("sha1").update(content).digest("hex"),
      0.8,
      ts,
      ts,
      ts,
      ts,
      sessionID || null
    )
    db.prepare(
      "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
    ).run(id, groupID, "summary", actor, JSON.stringify({ fields: FIELDS.filter((k) => s[k]) }), ts)
  }

  db.prepare(
    "INSERT INTO entities(id, type, name, props_json, created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).run(`memory:${id}`, "memory", content.slice(0, 60), JSON.stringify({ kind: "summary" }), ts)
  db.prepare(
    "INSERT INTO edges(src, predicate, dst, weight, created_at) VALUES(?,?,?,?,?) ON CONFLICT(src,predicate,dst) DO NOTHING"
  ).run(`memory:${id}`, "belongs_to", `group:${groupID}`, 1, ts)
  if (sessionID) {
    db.prepare(
      "INSERT INTO entities(id, type, name, props_json, created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
    ).run(`session:${sessionID}`, "session", sessionID, null, ts)
    db.prepare(
      "INSERT INTO edges(src, predicate, dst, weight, created_at) VALUES(?,?,?,?,?) ON CONFLICT(src,predicate,dst) DO NOTHING"
    ).run(`memory:${id}`, "from_session", `session:${sessionID}`, 1, ts)
  }

  applySummaryState(db, groupID, s, id, sessionID)
  return { id, created: !existing }
}
