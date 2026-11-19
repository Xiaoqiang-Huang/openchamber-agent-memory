// 存储治理：过期草稿、近似草稿合并、超限归档、事件 rollup、FTS 维护。
import { similarity } from "../capture/ingest.mjs"
import { kvGet, kvSet } from "./db.mjs"
import { pruneSessionStates } from "./state.mjs"

const DAY = 86400_000

function event(db, memoryId, groupId, action, actor, detail, ts) {
  db.prepare(
    "INSERT INTO memory_events(memory_id, group_id, action, actor, detail_json, created_at) VALUES(?,?,?,?,?,?)"
  ).run(memoryId, groupId || null, action, actor, detail ? JSON.stringify(detail) : null, ts)
}

export function runMaintenance(db, cfg = {}, nowTs = Date.now()) {
  const stats = { expiredDrafts: 0, mergedDrafts: 0, archived: 0, rolledUp: 0, prunedStates: 0, vacuumed: false }

  // 一次性修复：旧版本把「注入次数」记进 hits，导致命中数虚高。
  // hits 现在表示「重复捕获确认次数」，只统计 duplicate_hit / merge 事件。
  if (!kvGet(db, "hits_v2")) {
    db.exec(`UPDATE memories SET hits = (
      SELECT COUNT(*) FROM memory_events e
      WHERE e.memory_id = memories.id AND e.action IN ('duplicate_hit','merge')
    )`)
    kvSet(db, "hits_v2", "1")
    stats.hitsRepaired = true
  }

  // 1. 近似草稿合并：同组同类型、相似度 >= 0.9 的草稿只留信息量最大的一条
  const draftGroups = db
    .prepare("SELECT group_id FROM memories WHERE status='draft' GROUP BY group_id")
    .all()
  for (const g of draftGroups) {
    const drafts = db
      .prepare(
        `SELECT id, content, kind, confidence, detail FROM memories
         WHERE group_id=? AND status='draft' ORDER BY confidence DESC, updated_at DESC LIMIT 300`
      )
      .all(g.group_id)
    const kept = []
    for (const d of drafts) {
      const twin = kept.find((k) => k.kind === d.kind && similarity(k.content, d.content) >= 0.9)
      if (!twin) {
        kept.push(d)
        continue
      }
      const detail = [twin.detail, d.detail].filter(Boolean).join("\n").slice(0, 2000) || null
      db.prepare("UPDATE memories SET detail=?, confidence=MAX(confidence, ?), updated_at=? WHERE id=?").run(
        detail,
        d.confidence,
        nowTs,
        twin.id
      )
      db.prepare("DELETE FROM memories WHERE id=?").run(d.id)
      event(db, twin.id, g.group_id, "merge_draft", "maintenance", { dropped: d.id }, nowTs)
      stats.mergedDrafts++
    }
  }

  // 2. 进度类草稿过期更快：进度是易失信息
  const progressTtl = cfg?.draft?.progressTtlDays ?? 3
  if (progressTtl > 0) {
    const staleProgress = db
      .prepare(
        "SELECT id, group_id FROM memories WHERE status='draft' AND kind='progress' AND created_at < ?"
      )
      .all(nowTs - progressTtl * DAY)
    for (const m of staleProgress) {
      event(db, m.id, m.group_id, "expire", "maintenance", { reason: "progress_ttl" }, nowTs)
      db.prepare("DELETE FROM memories WHERE id=?").run(m.id)
      stats.expiredDrafts++
    }
  }

  // 3. 过期草稿：直接删除（候选不值得归档），先留事件
  const expired = db
    .prepare("SELECT id, group_id FROM memories WHERE status='draft' AND expires_at IS NOT NULL AND expires_at < ?")
    .all(nowTs)
  const del = db.prepare("DELETE FROM memories WHERE id = ?")
  for (const m of expired) {
    event(db, m.id, m.group_id, "expire", "maintenance", { reason: "draft_ttl" }, nowTs)
    del.run(m.id)
    stats.expiredDrafts++
  }

  // 2. 组内 promoted 超限：按 confidence / hits / 更新时间淘汰到 archived
  const max = cfg?.promoted?.maxPerGroup ?? 3000
  const groups = db
    .prepare("SELECT group_id, COUNT(*) AS n FROM memories WHERE status='promoted' GROUP BY group_id")
    .all()
  for (const g of groups) {
    const excess = g.n - max
    if (excess <= 0) continue
    const victims = db
      .prepare(
        `SELECT id FROM memories WHERE group_id=? AND status='promoted'
         ORDER BY confidence ASC, hits ASC, updated_at ASC LIMIT ?`
      )
      .all(g.group_id, excess)
    const upd = db.prepare("UPDATE memories SET status='archived', updated_at=? WHERE id=?")
    for (const v of victims) {
      upd.run(nowTs, v.id)
      event(db, v.id, g.group_id, "archive", "maintenance", { reason: "cap" }, nowTs)
      stats.archived++
    }
  }

  // 3. 会话级状态是缓存：长期不用就清掉，组级状态不动
  stats.prunedStates = pruneSessionStates(db, cfg?.state?.sessionTtlDays ?? 90, nowTs)

  // 4. 事件 rollup：老于 keepDays 的原始行聚合成日计数
  const keepDays = cfg?.events?.keepDays ?? 90
  const cutoff = nowTs - keepDays * DAY
  const oldRows = db
    .prepare(
      `SELECT group_id, action, date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS n
       FROM memory_events WHERE created_at < ? GROUP BY group_id, action, day`
    )
    .all(cutoff)
  const upsert = db.prepare(
    "INSERT INTO event_rollups(group_id, action, day, n) VALUES(?,?,?,?) ON CONFLICT(group_id,action,day) DO UPDATE SET n = n + excluded.n"
  )
  for (const r of oldRows) {
    upsert.run(r.group_id || "-", r.action, r.day, r.n)
    stats.rolledUp += r.n
  }
  if (oldRows.length) db.prepare("DELETE FROM memory_events WHERE created_at < ?").run(cutoff)

  // 5. FTS 与空闲页回收（失败不影响结果）
  try { db.exec("INSERT INTO memories_fts(memories_fts) VALUES('optimize')") } catch {}
  try { db.exec("PRAGMA incremental_vacuum"); stats.vacuumed = true } catch {}

  return stats
}
