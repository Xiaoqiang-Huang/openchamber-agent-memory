// 知识图谱数据：记忆 → 组/会话/主题/文件的边。供 HTTP 与 CLI 共用。
export function graphData(db, groupID) {
  const mems = groupID
    ? db.prepare("SELECT id FROM memories WHERE group_id = ? ORDER BY updated_at DESC LIMIT 300").all(groupID)
    : db.prepare("SELECT id FROM memories ORDER BY updated_at DESC LIMIT 300").all()
  const memNodeIds = mems.map((m) => "memory:" + m.id)
  if (!memNodeIds.length) return { nodes: [], edges: [] }

  const marks = memNodeIds.map(() => "?").join(",")
  const edges = db
    .prepare(`SELECT src, predicate, dst FROM edges WHERE src IN (${marks}) OR dst IN (${marks})`)
    .all(...memNodeIds, ...memNodeIds)

  const nodeIds = new Set(memNodeIds)
  for (const e of edges) { nodeIds.add(e.src); nodeIds.add(e.dst) }
  if (groupID) nodeIds.add("group:" + groupID)

  const memIds = memNodeIds.map((x) => x.slice("memory:".length))
  const marks2 = memIds.map(() => "?").join(",")
  const memMap = new Map(
    db.prepare(`SELECT id, content, status FROM memories WHERE id IN (${marks2})`).all(...memIds).map((m) => [m.id, m])
  )
  const nodes = []
  for (const id of nodeIds) {
    const ent = db.prepare("SELECT id, type, name FROM entities WHERE id = ?").get(id)
    const mem = id.startsWith("memory:") ? memMap.get(id.slice("memory:".length)) : null
    nodes.push({
      id,
      type: ent?.type || (id.startsWith("memory:") ? "memory" : "unknown"),
      label: (mem?.content || ent?.name || id).slice(0, 30),
      status: mem?.status || null,
      group: groupID || null,
    })
  }
  const idset = new Set(nodes.map((n) => n.id))
  return { nodes, edges: edges.filter((e) => idset.has(e.src) && idset.has(e.dst)) }
}
