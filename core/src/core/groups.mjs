// 记忆组视图与保存：groups.json 是唯一配置源。
import { readFileSync, writeFileSync } from "node:fs"
import { GROUPS_PATH } from "./config.mjs"

export function readGroupsFile() {
  try {
    const parsed = JSON.parse(readFileSync(GROUPS_PATH, "utf8"))
    return { groups: Array.isArray(parsed.groups) ? parsed.groups : [] }
  } catch {
    return { groups: [] }
  }
}

export function groupsView(db) {
  const configured = readGroupsFile().groups
  const counts = new Map(
    db.prepare("SELECT group_id, COUNT(*) AS n FROM memories GROUP BY group_id").all().map((r) => [r.group_id, r.n])
  )
  const rows = configured.map((g) => ({
    id: g.id, name: g.name || g.id, kind: "manual", n: counts.get(g.id) || 0, paths: g.paths || [],
  }))
  for (const [id, n] of counts) {
    if (rows.some((r) => r.id === id)) continue
    const dbRow = db.prepare("SELECT name, kind FROM memory_groups WHERE id = ?").get(id)
    rows.push({ id, name: dbRow?.name || id, kind: dbRow?.kind || "auto", n, paths: [] })
  }
  return rows
}

const normPath = (p) => String(p || "").replace(/\\/g, "/").toLowerCase()

export function saveGroup({ id, name, paths }) {
  const gid = String(id || "").trim()
  const cleanName = String(name || "").trim() || gid
  const cleanPaths = (paths || []).map((p) => String(p).trim()).filter(Boolean)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(gid)) return { ok: false, error: "ID 只能用字母、数字、点、下划线、连字符" }
  if (!cleanPaths.length) return { ok: false, error: "至少需要一个路径" }

  const file = readGroupsFile()
  for (const g of file.groups) {
    if (g.id === gid) continue
    const clash = (g.paths || []).find((p) => cleanPaths.some((q) => normPath(p) === normPath(q)))
    if (clash) return { ok: false, error: `路径 ${clash} 已属于组 ${g.id}` }
  }

  const idx = file.groups.findIndex((g) => g.id === gid)
  const entry = { id: gid, name: cleanName, paths: cleanPaths }
  if (idx >= 0) file.groups[idx] = entry
  else file.groups.push(entry)
  writeFileSync(GROUPS_PATH, JSON.stringify(file, null, 2) + "\n", "utf8")
  return { ok: true, group: entry }
}
