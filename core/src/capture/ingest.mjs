// 把提炼结果写入草稿区与图谱。只做确定性校验，不调用模型。
import { createHash } from "node:crypto"
import { statSync } from "node:fs"
import { DB_PATH, ensureGroup, loadConfig } from "../core/config.mjs"
import { supersedeMemory } from "../core/memory.mjs"
import { saveSessionSummary } from "./summary.mjs"

const KINDS = new Set(["decision", "pitfall", "progress", "reference", "preference", "procedure"])
const LIMITS = { content: 300, detail: 2000, evidence: 500 }

export function normalize(text) {
  return String(text || "").replace(/\s+/g, " ").trim()
}

// 去空白与标点后再哈希：中文/英文标点、大小写差异不影响“同一条记忆”的判断
export function canonical(text) {
  return normalize(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")
}

export function hashContent(text) {
  return createHash("sha1").update(canonical(text)).digest("hex")
}

function bigrams(text) {
  const t = canonical(text)
  const out = new Set()
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2))
  return out
}

export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return inter / (A.size + B.size - inter)
}

export function topicOverlap(a = [], b = []) {
  if (!a.length || !b.length) return 0
  const set = new Set(a.map((t) => String(t).toLowerCase()))
  let n = 0
  for (const t of b) if (set.has(String(t).toLowerCase())) n++
  return n
}

export function parseCandidates(raw) {
  if (Array.isArray(raw)) return raw
  const text = String(raw || "")
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parsePayload(raw) {
  const text = String(raw || "")
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1))
      if (parsed && Array.isArray(parsed.items)) {
        return {
          items: parsed.items,
          decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
          summary: parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null,
        }
      }
    } catch {}
  }
  return { items: parseCandidates(text), decisions: [], summary: null }
}

function cleanCandidate(c) {
  if (!c || typeof c !== "object") return null
  const kind = String(c.kind || "").trim()
  const content = normalize(c.content)
  if (!KINDS.has(kind) || !content) return null
  const evidence = normalize(c.evidence)
  if (!evidence) return null // 没有原话支撑的不入库
  return {
    kind,
    content: content.slice(0, LIMITS.content),
    detail: c.detail ? normalize(c.detail).slice(0, LIMITS.detail) : null,
    confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)),
    evidence: evidence.slice(0, LIMITS.evidence),
    topics: Array.isArray(c.topics)
      ? c.topics.map((t) => normalize(t)).filter(Boolean).slice(0, 4)
      : [],
  }
}

// 同批候选合并：同义/同主题的条目只留一条，避免一次会话灌进 4 条近义草稿
function mergeCandidate(into, c) {
  if (c.content.length > into.content.length) into.content = c.content
  into.confidence = Math.max(into.confidence, c.confidence)
  into.detail = [into.detail, c.detail].filter(Boolean).join("\n").slice(0, LIMITS.detail) || null
  const evidences = [...new Set([into.evidence, c.evidence].filter(Boolean))]
  into.evidence = evidences.join(" / ").slice(0, LIMITS.evidence)
  into.topics = [...new Set([...into.topics, ...c.topics])].slice(0, 6)
}

function sameIdea(a, b) {
  if (a.kind !== b.kind) return false
  const s = similarity(a.content, b.content)
  if (s >= 0.8) return true
  const shared = topicOverlap(a.topics, b.topics)
  return shared >= 2 && s >= 0.5
}

function insertEntity(db, id, type, name, props = null) {
  db.prepare(
    "INSERT INTO entities(id, type, name, props_json, created_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
  ).run(id, type, name, props ? JSON.stringify(props) : null, Date.now())
}

function insertEdge(db, src, predicate, dst, weight = 1) {
  db.prepare(
    "INSERT INTO edges(src, predicate, dst, weight, created_at) VALUES(?,?,?,?,?) ON CONFLICT(src,predicate,dst) DO NOTHING"
  ).run(src, predicate, dst, weight, Date.now())
}

function insertEvent(db, memoryId, groupId, action, actor, detail) {
  db.prepare(
    "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
  ).run(memoryId, groupId, action, actor, detail ? JSON.stringify(detail) : null, Date.now())
}

function topicsOf(db, memoryId) {
  return db
    .prepare(
      `SELECT e.name AS name FROM edges g JOIN entities e ON e.id = g.dst
       WHERE g.src = ? AND g.predicate = 'about'`
    )
    .all(`memory:${memoryId}`)
    .map((r) => r.name)
}

function attachTopics(db, memoryId, topics) {
  for (const topic of topics) {
    const topicId = `topic:${normalize(topic).toLowerCase()}`
    insertEntity(db, topicId, "topic", topic)
    insertEdge(db, `memory:${memoryId}`, "about", topicId)
  }
}

function touchDuplicate(db, id, c, groupId, actor, now) {
  db.prepare("UPDATE memories SET hits = hits + 1, updated_at = ?, last_seen_at = ? WHERE id = ?").run(
    now,
    now,
    id
  )
  insertEvent(db, id, groupId, "duplicate_hit", actor, { content: c.content })
}

function mergeIntoMemory(db, mem, c, groupId, actor, now) {
  const content = c.content.length > String(mem.content).length ? c.content : mem.content
  const detail = c.detail
    ? [mem.detail, c.detail].filter(Boolean).join("\n").slice(0, LIMITS.detail)
    : mem.detail
  const confidence = Math.max(Number(mem.confidence) || 0, c.confidence)
  db.prepare(
    `UPDATE memories SET content=?, detail=?, confidence=?, hits=hits+1, updated_at=?, last_seen_at=?,
       content_hash=? WHERE id=?`
  ).run(content, detail, confidence, now, now, hashContent(content), mem.id)
  attachTopics(db, mem.id, c.topics)
  insertEvent(db, mem.id, groupId, "merge", actor, {
    content: c.content,
    evidence: c.evidence,
    into: mem.id,
  })
}

export function ingestCandidates(
  db,
  { group, dir, sessionID, candidates, decisions = [], summary = null, actor = "plugin" }
) {
  const cfg = loadConfig()
  ensureGroup(db, group)

  // 硬预算：超过后拒绝写入（读与后台不受影响）
  const hard = (cfg.budget?.hardMb ?? 500) * 1024 * 1024
  try {
    const size = statSync(DB_PATH).size
    if (size > hard) {
      insertEvent(db, null, group.id, "budget_blocked", "system", { size, hard })
      return { inserted: 0, duplicated: 0, merged: 0, rejected: candidates.length, budgetBlocked: true, ids: [] }
    }
  } catch {}

  const result = {
    inserted: 0, duplicated: 0, merged: 0, rejected: 0, conflicts: 0,
    superseded: 0, judged: 0, summaryId: null, ids: [],
  }
  const now = Date.now()
  const ttl = now + (cfg.draft?.ttlDays ?? 7) * 86400_000

  // 同组草稿上限：先清过期，再按最旧删
  const draftCount = db
    .prepare("SELECT COUNT(*) AS n FROM memories WHERE group_id = ? AND status = 'draft'")
    .get(group.id)?.n ?? 0
  const room = Math.max(0, (cfg.draft?.maxPerGroup ?? 200) - draftCount)

  // 1) 清洗 + 同批合并
  const accepted = []
  for (const raw of candidates) {
    const c = cleanCandidate(raw)
    if (!c) {
      result.rejected++
      continue
    }
    const twin = accepted.find((x) => sameIdea(x, c))
    if (twin) {
      mergeCandidate(twin, c)
      result.merged++
      continue
    }
    accepted.push(c)
  }

  // 2) 与已有记忆比对：完全重复 / 合并进草稿 / 与生效记忆冲突 / 新增
  const pool = db
    .prepare(
      `SELECT id, content, detail, kind, status, confidence FROM memories
       WHERE group_id = ? AND status IN ('draft','promoted','conflicted')
       ORDER BY updated_at DESC LIMIT 500`
    )
    .all(group.id)
  const byHash = new Map(pool.map((m) => [hashContent(m.content), m]))

  // 模型裁决按候选原文对齐；同批合并可能丢掉某条，丢掉的自然也不需要用它的裁决
  const decisionByContent = new Map()
  for (const d of decisions || []) {
    const key = normalize(d?.content)
    const verdict = String(d?.verdict || "")
    if (!key || !["duplicate", "supersedes", "unrelated"].includes(verdict)) continue
    decisionByContent.set(key, { ...d, verdict })
  }

  let draftInserted = 0
  for (const c of accepted) {
    const hash = hashContent(c.content)
    const exact = byHash.get(hash)
    if (exact) {
      touchDuplicate(db, exact.id, c, group.id, actor, now)
      result.duplicated++
      continue
    }

    const verdict = decisionByContent.get(normalize(c.content)) || null
    const target =
      verdict?.target
        ? db.prepare("SELECT * FROM memories WHERE id = ? AND group_id = ?").get(verdict.target, group.id)
        : null
    const targetOk = Boolean(target && target.status === "promoted" && !target.valid_to)

    if (verdict?.verdict === "duplicate" && targetOk) {
      touchDuplicate(db, target.id, c, group.id, actor, now)
      attachTopics(db, target.id, c.topics)
      result.judged++
      result.duplicated++
      continue
    }

    let best = null
    let bestPromoted = null
    for (const m of pool) {
      const s = similarity(c.content, m.content)
      if (s < 0.4) continue
      const topicBonus = s >= 0.5 && topicOverlap(c.topics, topicsOf(db, m.id)) >= 2 ? 0.06 : 0
      const score = s + topicBonus + (m.kind === c.kind ? 0.02 : 0)
      if (!best || score > best.score) best = { m, s, score }
      if (m.status === "promoted" && s >= 0.75 && (!bestPromoted || s > bestPromoted.s)) {
        bestPromoted = { m, s }
      }
    }

    // 与生效记忆冲突优先于合并进草稿：先让人裁决，不要把冲突藏进草稿。
    // 模型已经裁决为 supersedes / unrelated 时，不再按相似度自动标冲突。
    const judgedSupersede = verdict?.verdict === "supersedes" && targetOk
    const judgedUnrelated = verdict?.verdict === "unrelated"
    const conflictWith = judgedSupersede || judgedUnrelated ? null : bestPromoted ? bestPromoted.m : null
    if (!conflictWith && best && best.m.status === "draft" && (best.s >= 0.8 || (best.s >= 0.5 && best.score >= 0.56))) {
      mergeIntoMemory(db, best.m, c, group.id, actor, now)
      result.merged++
      continue
    }

    // 自动晋升（显式开启才生效）
    const ap = cfg.capture?.autoPromote
    const autoKinds = ap?.kinds || ["decision", "preference", "procedure"]
    const auto =
      Boolean(ap?.enabled) &&
      !conflictWith &&
      c.confidence >= (ap?.minConfidence ?? 0.9) &&
      autoKinds.includes(c.kind)

    const status = judgedSupersede ? "draft" : auto ? "promoted" : conflictWith ? "conflicted" : "draft"
    if (status === "draft" && draftInserted >= room) {
      result.rejected++
      continue
    }
    if (status === "draft") draftInserted++
    const id = "m_" + createHash("sha1").update(group.id + ":" + hash + ":" + now).digest("hex").slice(0, 16)
    db.prepare(
      `INSERT INTO memories(id, group_id, kind, status, content, detail, source_json, content_hash,
                            confidence, hits, created_at, updated_at, expires_at, last_used_at,
                            valid_from, valid_to, superseded_by, last_seen_at, pinned,
                            session_id, last_injected_at)
       VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,NULL,?,NULL,NULL,?,0,?,NULL)`
    ).run(
      id,
      group.id,
      c.kind,
      status,
      c.content,
      c.detail,
      JSON.stringify({ session_id: sessionID || null, dir: dir || null, evidence: c.evidence }),
      hash,
      c.confidence,
      now,
      now,
      auto ? null : ttl,
      auto ? now : null,
      now,
      sessionID || null
    )

    const memEntity = `memory:${id}`
    insertEntity(db, memEntity, "memory", c.content.slice(0, 60), { kind: c.kind })
    insertEntity(db, `group:${group.id}`, "group", group.name || group.id)
    insertEdge(db, memEntity, "belongs_to", `group:${group.id}`)
    if (sessionID) {
      insertEntity(db, `session:${sessionID}`, "session", sessionID)
      insertEdge(db, memEntity, "from_session", `session:${sessionID}`)
    }
    attachTopics(db, id, c.topics)

    if (conflictWith) {
      insertEdge(db, memEntity, "conflicts", `memory:${conflictWith.id}`)
      insertEdge(db, `memory:${conflictWith.id}`, "conflicts", memEntity)
      insertEvent(db, id, group.id, "conflict", actor, {
        with: conflictWith.id,
        evidence: c.evidence,
      })
      result.conflicts++
    }

    insertEvent(db, id, group.id, auto ? "auto_promote" : "capture", actor, {
      kind: c.kind,
      confidence: c.confidence,
      evidence: c.evidence,
      session_id: sessionID || null,
    })

    if (verdict) {
      insertEvent(db, id, group.id, "judge", actor, {
        verdict: verdict.verdict,
        target: verdict.target || null,
        reason: verdict.reason || null,
      })
      result.judged++
    }
    if (judgedSupersede) {
      // 只有明确的“替换/终止”才让旧条目失效；旧行保留，valid_to 可回查
      supersedeMemory(db, target.id, id, "judge")
      result.superseded++
    }

    result.inserted++
    result.ids.push(id)
  }

  if (summary) {
    const saved = saveSessionSummary(db, { group, dir, sessionID, summary, actor })
    if (saved) result.summaryId = saved.id
  }

  return result
}
