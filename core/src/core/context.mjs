// 注入上下文：只允许 promoted 且当前有效（valid_to IS NULL）的记忆。
// 有查询时按「相关度 + 重要度」排序；没有查询时按重要度。受字符预算约束。
import { now } from "./db.mjs"
import { getStateForContext, formatState, touchStateInjected } from "./state.mjs"

const DAY = 86400_000

const KIND_LABEL = {
  decision: "决策",
  pitfall: "踩坑",
  progress: "进度",
  reference: "资料",
  preference: "偏好",
  procedure: "做法",
  summary: "摘要",
}

const KIND_WEIGHT = {
  decision: 3.2,
  preference: 2.8,
  pitfall: 2.4,
  procedure: 2.2,
  summary: 2.6,
  reference: 1.4,
  progress: 1.2,
}

function groupName(db, id) {
  return db.prepare("SELECT name FROM memory_groups WHERE id = ?").get(id)?.name || id
}

function ageLabel(ts, tsNow) {
  const d = Math.floor((tsNow - ts) / DAY)
  if (d <= 0) return "今天"
  if (d === 1) return "昨天"
  if (d < 30) return `${d} 天前`
  const date = new Date(ts)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

// 中文没有空格：按 2-gram / 3-gram 切；英文按词。最多 18 个词，长词优先。
export function queryTerms(query) {
  const q = String(query || "").toLowerCase().replace(/\s+/g, " ").trim().slice(-300)
  if (!q) return []
  const terms = new Set()
  for (const part of q.split(/[^\p{L}\p{N}]+/u)) {
    if (!part) continue
    if (/[\u3400-\u9fff]/.test(part)) {
      for (let n = 2; n <= Math.min(4, part.length); n++) {
        for (let i = 0; i <= part.length - n; i++) terms.add(part.slice(i, i + n))
      }
    } else if (part.length >= 3) {
      terms.add(part)
    }
  }
  return [...terms].sort((a, b) => b.length - a.length).slice(0, 18)
}

function matchScore(text, terms) {
  let n = 0
  for (const t of terms) {
    if (text.includes(t)) n += t.length >= 3 ? 2 : 1
  }
  return n
}

function candidates(db, groupID, minConfidence, limit = 400) {
  return db
    .prepare(
      `SELECT id, content, kind, confidence, hits, created_at, updated_at, last_used_at,
              last_seen_at, pinned
       FROM memories
       WHERE group_id = ? AND status = 'promoted' AND valid_to IS NULL
         AND kind != 'summary' AND confidence >= ?
       ORDER BY updated_at DESC LIMIT ?`
    )
    .all(groupID, minConfidence, limit)
}

function rank(rows, terms, tsNow) {
  const scored = rows.map((r) => {
    const text = String(r.content).toLowerCase()
    const q = terms.length ? matchScore(text, terms) : 0
    const ageDays = Math.max(0, (tsNow - (r.updated_at || r.created_at)) / DAY)
    const recency = 1 / (1 + ageDays / 60)
    const usage = Math.min(3, Math.log1p(r.hits || 0))
    const recentUse = r.last_used_at ? 1 / (1 + Math.max(0, tsNow - r.last_used_at) / (30 * DAY)) : 0
    const score =
      (KIND_WEIGHT[r.kind] || 1) +
      (Number(r.confidence) || 0) * 2.2 +
      usage +
      recency * 1.2 +
      recentUse * 0.5 +
      (r.pinned ? 4 : 0) +
      q * 2.2
    return { r, score, q }
  })
  scored.sort((a, b) => b.score - a.score || b.r.updated_at - a.r.updated_at)
  return scored
}

// 状态类记忆：超过两周没有被复述/确认，就在行内标出来
function staleTag(r, tsNow) {
  if (r.kind !== "progress" && r.kind !== "summary") return ""
  const last = r.last_seen_at || r.updated_at || r.created_at
  const days = Math.max(0, Math.floor((tsNow - last) / DAY))
  return days >= 14 ? ` · 未复核 ${days} 天` : ""
}

function fill(scored, budget, limit, tsNow) {
  const out = []
  let used = 0
  for (const item of scored) {
    if (out.length >= limit) break
    const line = `- [${KIND_LABEL[item.r.kind] || item.r.kind} · ${ageLabel(item.r.updated_at || item.r.created_at, tsNow)}${staleTag(item.r, tsNow)}] ${item.r.content}`
    if (out.length >= 1 && used + line.length + 1 > budget) break
    out.push({ id: item.r.id, line })
    used += line.length + 1
  }
  return out
}

export function buildContext(
  db,
  {
    groupID,
    sessionID = "",
    query = "",
    globalLimit = 6,
    groupLimit = 10,
    budgetChars = 1400,
    minConfidence = 0.45,
  } = {}
) {
  if (!groupID) return ""
  const tsNow = now()
  const terms = queryTerms(query)
  const minConf = Math.max(0, Math.min(1, Number(minConfidence) || 0))

  // 当前状态与会话摘要优先：它们是“现在是什么”，不是又一条历史
  const prefixBudget = Math.min(600, Math.round(budgetChars * 0.4))
  const state = groupID === "global" ? { scope: "group", rows: [] } : getStateForContext(db, groupID, sessionID)
  const stateRaw = formatState(state.rows, tsNow, state.scope)
  const stateText = stateRaw.length > prefixBudget ? stateRaw.slice(0, prefixBudget) : stateRaw

  const summaryBase =
    "SELECT id, content, created_at, updated_at, last_seen_at, session_id, last_injected_at " +
    "FROM memories WHERE group_id = ? AND kind = 'summary' AND status = 'promoted' AND valid_to IS NULL"
  const ownSummary =
    groupID !== "global" && sessionID
      ? db.prepare(summaryBase + " AND session_id = ? ORDER BY created_at DESC LIMIT 1").get(groupID, sessionID)
      : null
  const otherSummaries =
    groupID === "global"
      ? []
      : sessionID
        ? db.prepare(summaryBase + " AND (session_id IS NULL OR session_id != ?) ORDER BY created_at DESC LIMIT 2").all(groupID, sessionID)
        : db.prepare(summaryBase + " ORDER BY created_at DESC LIMIT 2").all(groupID)
  const summaryRows = [
    ...(ownSummary ? [{ ...ownSummary, own: true }] : []),
    ...otherSummaries.map((r) => ({ ...r, own: false })),
  ].slice(0, 2)
  const summaryLines = []
  const injectedSummaryIds = []
  let prefixUsed = stateText.length
  for (const r of summaryRows) {
    const label = r.own ? "本会话摘要" : "其他会话摘要"
    const line = `- [${label} · ${ageLabel(r.updated_at || r.created_at, tsNow)}${staleTag({ ...r, kind: "summary" }, tsNow)}] ${String(r.content).slice(0, 240)}`
    if (prefixUsed + line.length + 1 > prefixBudget) break
    summaryLines.push(line)
    injectedSummaryIds.push(r.id)
    prefixUsed += line.length + 1
  }
  const prefixParts = []
  if (stateText) prefixParts.push(stateText)
  if (summaryLines.length) prefixParts.push("会话摘要：" + '\n' + summaryLines.join('\n'))
  const prefix = prefixParts.join('\n\n')
  const remaining = Math.max(0, budgetChars - (prefix ? prefix.length + 2 : 0))

  const globalRows = candidates(db, "global", minConf, 200)
  const groupRows = groupID === "global" ? [] : candidates(db, groupID, minConf, 400)
  const globalScored = rank(globalRows, terms, tsNow)
  const groupScored = rank(groupRows, terms, tsNow)

  // 先给跨项目偏好三分之一预算，余下给当前组
  const globalBudget = Math.round(remaining * 0.35)
  const globalPicked = fill(globalScored, globalBudget, globalLimit, tsNow)
  const groupPicked = fill(groupScored, remaining - globalPicked.reduce((n, x) => n + x.line.length + 1, 0), groupLimit, tsNow)
  if (!prefix && !globalPicked.length && !groupPicked.length) return ""

  const touch = db.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?")
  for (const x of [...globalPicked, ...groupPicked]) touch.run(tsNow, x.id)
  if (injectedSummaryIds.length) {
    const marks = injectedSummaryIds.map(() => "?").join(",")
    db.prepare(`UPDATE memories SET last_injected_at = ? WHERE id IN (${marks})`).run(tsNow, ...injectedSummaryIds)
  }
  touchStateInjected(db, state, tsNow)

  const parts = []
  if (prefix) parts.push(prefix)
  if (globalPicked.length) parts.push("跨项目偏好：\n" + globalPicked.map((x) => x.line).join("\n"))
  if (groupPicked.length) parts.push(`${groupName(db, groupID)}：\n` + groupPicked.map((x) => x.line).join("\n"))

  return (
    `<agent-memory group="${groupID}">\n` +
    `以下是过去会话中保留下来的长期记忆，仅在与当前任务相关时参考：\n` +
    parts.join("\n\n") +
    `\n</agent-memory>`
  )
}

export { KIND_LABEL }
