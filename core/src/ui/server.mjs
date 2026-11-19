// 管理后台：node:http + 服务端渲染。插件与独立 CLI 共用同一份数据。
import { createServer } from "node:http"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { dbStats, openDb } from "../core/db.mjs"
import { DB_PATH, GROUPS_PATH, loadConfig, readHeartbeat } from "../core/config.mjs"
import { groupsView, saveGroup } from "../core/groups.mjs"
import { graphData } from "../core/graph.mjs"
import { listMemories, getMemory, promoteMemory, demoteMemory, forgetMemory, restoreMemory, updateMemory, resolveConflict } from "../core/memory.mjs"
import { statusPage, memoriesPage, draftsPage, memoryPage, groupsPage, eventsPage, statsPage, graphPage, conflictsPage } from "./views.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDOR = join(HERE, "..", "..", "vendor")
const MIME = { ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml" }

const ACTIONS = { promote: promoteMemory, demote: demoteMemory, forget: forgetMemory, restore: restoreMemory }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c) => {
      data += c
      if (data.length > 1_000_000) { reject(new Error("body too large")); req.destroy() }
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

function redirect(res, to) {
  res.writeHead(302, { location: to || "/" })
  res.end()
}

export async function startServer({ host, port } = {}) {
  const cfg = loadConfig()
  const h = host || cfg.ui.host
  const p = port || cfg.ui.port
  const { db, driverName } = await openDb(DB_PATH)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || `${h}:${p}`}`)
    const path = url.pathname
    try {
      if (path === "/health") {
        const size = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        return res.end(JSON.stringify({ ok: true, db: DB_PATH, driver: driverName, size, stats: dbStats(db), heartbeat: readHeartbeat() }, null, 2))
      }
      if (path.startsWith("/assets/")) {
        const file = join(VENDOR, path.slice("/assets/".length))
        if (!file.startsWith(VENDOR) || !existsSync(file)) return res.writeHead(404).end("not found")
        res.writeHead(200, { "content-type": MIME[file.slice(file.lastIndexOf("."))] || "application/octet-stream", "cache-control": "public, max-age=3600" })
        return res.end(readFileSync(file))
      }

      // ── 写操作 ──────────────────────────────────────────────────────────────
      if (req.method === "POST" && path.startsWith("/actions/")) {
        const action = path.slice("/actions/".length)
        const form = new URLSearchParams(await readBody(req))
        const id = form.get("id")
        const next = form.get("next") || "/"
        if (action === "edit") {
          updateMemory(db, id, { content: form.get("content"), detail: form.get("detail") }, "user")
        } else if (action === "group-save") {
          const result = saveGroup({
            id: form.get("id"),
            name: form.get("name"),
            paths: (form.get("paths") || "").split(/\r?\n/),
          })
          if (!result.ok) return res.writeHead(400).end(result.error)
        } else if (action === "resolve") {
          resolveConflict(db, form.get("keep"), form.get("drop"), "user")
        } else if (ACTIONS[action]) {
          ACTIONS[action](db, id, "user")
        } else {
          return res.writeHead(400).end("unknown action")
        }
        return redirect(res, next)
      }

      // ── 读页面 ──────────────────────────────────────────────────────────────
      if (path === "/") {
        const stats = dbStats(db)
        const groups = groupsView(db)
        stats.groups = groups.length
        const events = db.prepare("SELECT * FROM memory_events ORDER BY id DESC LIMIT 10").all()
        const dbSize = [DB_PATH, DB_PATH + "-wal"].filter(existsSync).reduce((n, f) => n + statSync(f).size, 0)
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(statusPage({ stats, dbSize, dbPath: DB_PATH, driver: driverName, heartbeat: readHeartbeat(), groups, events, budget: cfg.budget }))
      }

      if (path === "/memories") {
        const filters = {
          group: url.searchParams.get("group") || "",
          status: url.searchParams.get("status") || "",
          q: url.searchParams.get("q") || "",
        }
        const page = Math.max(1, Number(url.searchParams.get("page") || 1))
        const rows = listMemories(db, { groupID: filters.group || undefined, status: filters.status || undefined, query: filters.q || undefined, limit: 30, offset: (page - 1) * 30 })
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(memoriesPage({ rows, total: rows.total, page, filters, groups: groupsView(db) }))
      }

      if (path.startsWith("/memories/")) {
        const id = decodeURIComponent(path.slice("/memories/".length))
        const m = getMemory(db, id)
        if (!m) return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found")
        const groupName = db.prepare("SELECT name FROM memory_groups WHERE id = ?").get(m.group_id)?.name || m.group_id
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(memoryPage({ m, groupName }))
      }

      if (path === "/drafts") {
        const rows = listMemories(db, { status: "draft", limit: 100 })
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(draftsPage({ rows, groups: groupsView(db) }))
      }

      if (path === "/conflicts") {
        const rows = db
          .prepare("SELECT src, dst FROM edges WHERE predicate = 'conflicts' LIMIT 200")
          .all()
        const seen = new Set()
        const pairs = []
        for (const r of rows) {
          const a = r.src.replace(/^memory:/, "")
          const b = r.dst.replace(/^memory:/, "")
          const key = [a, b].sort().join("|")
          if (seen.has(key)) continue
          seen.add(key)
          const ma = db.prepare("SELECT id, content, status FROM memories WHERE id = ?").get(a)
          const mb = db.prepare("SELECT id, content, status FROM memories WHERE id = ?").get(b)
          if (ma && mb) pairs.push({ a: ma, b: mb })
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(conflictsPage({ pairs }))
      }

      if (path === "/groups") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(groupsPage({ groups: groupsView(db) }))
      }

      if (path === "/events") {
        const filters = { group: url.searchParams.get("group") || "", q: url.searchParams.get("q") || "" }
        const rows = filters.group
          ? db.prepare("SELECT * FROM memory_events WHERE group_id = ? ORDER BY id DESC LIMIT 200").all(filters.group)
          : db.prepare("SELECT * FROM memory_events ORDER BY id DESC LIMIT 200").all()
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(eventsPage({ rows, filters, groups: groupsView(db) }))
      }

      if (path === "/stats") {
        const rollups = db.prepare("SELECT * FROM event_rollups ORDER BY day DESC LIMIT 100").all()
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(statsPage({ stats: dbStats(db), rollups, groups: groupsView(db) }))
      }

      if (path === "/graph") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        return res.end(graphPage({ groups: groupsView(db) }))
      }

      if (path === "/api/graph") {
        const data = graphData(db, url.searchParams.get("group") || null)
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        return res.end(JSON.stringify(data))
      }

      if (path.startsWith("/api/memory/")) {
        const m = getMemory(db, decodeURIComponent(path.slice("/api/memory/".length)))
        if (!m) return res.writeHead(404).end("{}")
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
        return res.end(JSON.stringify(m))
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
      res.end("not found")
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      res.end("internal error: " + (err?.message || err))
    }
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(p, h, resolve)
  })

  return { server, url: `http://${h}:${p}`, close: () => new Promise((r) => server.close(r)) }
}
