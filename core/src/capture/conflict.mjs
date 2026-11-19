// 冲突裁决：只做“找候选 + 组提示词 + 校验模型输出”，不直接调用模型。
// 规则借 Graphiti：进度/活动/状态更新不算矛盾，只有明确的终止/替换才让旧条目失效。
import { normalize, similarity, topicOverlap } from "./ingest.mjs"

const VERDICTS = new Set(["duplicate", "supersedes", "unrelated"])

function topicsOf(db, memoryId) {
  return db
    .prepare(
      `SELECT e.name AS name FROM edges g JOIN entities e ON e.id = g.dst
       WHERE g.src = ? AND g.predicate = 'about'`
    )
    .all(`memory:${memoryId}`)
    .map((r) => r.name)
}

export function findConflictCandidates(db, groupID, items, { limit = 3 } = {}) {
  const pool = db
    .prepare(
      `SELECT id, content, kind FROM memories
       WHERE group_id = ? AND status = 'promoted' AND valid_to IS NULL
       ORDER BY updated_at DESC LIMIT 300`
    )
    .all(groupID)
  if (!pool.length) return []
  const topicCache = new Map()
  const topics = (id) => {
    if (!topicCache.has(id)) topicCache.set(id, topicsOf(db, id))
    return topicCache.get(id)
  }

  const out = []
  for (const item of items || []) {
    const content = normalize(item?.content)
    if (!content) continue
    const scored = []
    for (const m of pool) {
      const s = similarity(content, m.content)
      if (s < 0.5) continue
      const overlap = topicOverlap(item.topics || [], topics(m.id))
      if (s < 0.6 && !(s >= 0.5 && overlap >= 2)) continue
      scored.push({ id: m.id, content: m.content, kind: m.kind, similarity: s, overlap })
    }
    scored.sort((a, b) => b.similarity - a.similarity)
    if (scored.length) out.push({ item, candidates: scored.slice(0, limit) })
  }
  return out
}

export function buildJudgePrompt(entries) {
  const lines = []
  entries.forEach((entry, i) => {
    lines.push(`[${i}] (${entry.item.kind || "?"}) ${entry.item.content}`)
    for (const c of entry.candidates) {
      lines.push(`    候选 ${c.id} | (${c.kind}) ${c.content}`)
    }
  })
  return `你是记忆冲突裁决器。判断每条“新事实”和它下面列出的“现有生效记忆”是什么关系。

只允许三种结论：
- duplicate：同一事实，语义等价，只是措辞不同；
- supersedes：新事实明确终止、替换、转移了旧事实（版本升级、决定改变、角色更换、明确否定旧做法）；
- unrelated：可以同时为真，或只是进度、活动、状态更新、补充细节。

规则：
1. 进度、活动、状态更新（“已跑通”“完成了”“测了 N 个”）不算矛盾，选 unrelated。
2. 不同日期发生的两件事不算矛盾。
3. 没有明确替换/终止证据时，选 unrelated；不要因为相似就判 supersedes。
4. target 只能从该条新事实下列出的候选 id 里选；unrelated 的 target 为 null。
5. 一条新事实只输出一个结论，选最相关的一个候选。

新事实与候选：
${lines.join("\n")}

只输出 JSON 数组，不要解释、不要 markdown：
[{"content":"新事实原文","verdict":"duplicate|supersedes|unrelated","target":"m_xxx 或 null","reason":"≤40字"}]
`
}

function findEntry(entries, raw, index) {
  if (Number.isInteger(index) && entries[index]) return entries[index]
  const key = normalize(raw)
  if (!key) return null
  return entries.find((e) => normalize(e.item.content) === key) || null
}

export function parseJudgeOutput(text, entries) {
  const t = String(text || "")
  const start = t.indexOf("[")
  const end = t.lastIndexOf("]")
  if (start === -1 || end <= start) return []
  let raw
  try {
    raw = JSON.parse(t.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const d of raw) {
    const verdict = String(d?.verdict || "").trim()
    if (!VERDICTS.has(verdict)) continue
    const entry = findEntry(entries, d?.content, Number(d?.index))
    if (!entry) continue
    const key = normalize(entry.item.content)
    if (seen.has(key)) continue
    const allowed = new Set(entry.candidates.map((c) => c.id))
    let target = d?.target == null ? null : String(d.target)
    if (verdict !== "unrelated" && (!target || !allowed.has(target))) continue
    if (verdict === "unrelated") target = null
    seen.add(key)
    out.push({
      content: entry.item.content,
      verdict,
      target,
      reason: String(d?.reason || "").slice(0, 80),
    })
  }
  return out
}
