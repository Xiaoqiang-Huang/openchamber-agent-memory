#!/usr/bin/env node
// mem — agent-memory 的独立入口（不依赖 OpenCode/OpenChamber）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

import { backupDb, dbStats, migrate, openDb, kvGet, kvSet } from "../src/core/db.mjs"
import { ingestCandidates, parseCandidates, parsePayload } from "../src/capture/ingest.mjs"
import {
  promoteMemory, demoteMemory, forgetMemory, restoreMemory, listMemories, getMemory,
  resolveConflict, supersedeMemory, pinMemory,
} from "../src/core/memory.mjs"
import { buildContext } from "../src/core/context.mjs"
import {
  getState, setState, formatState, STATE_LABELS,
  getSessionState, setSessionState, listSessionStates,
} from "../src/core/state.mjs"
import { groupsView, saveGroup } from "../src/core/groups.mjs"
import { graphData } from "../src/core/graph.mjs"
import { runMaintenance } from "../src/core/retention.mjs"
import {
  DATA_DIR, DB_PATH, CONFIG_PATH, GROUPS_PATH, HEARTBEAT_PATH,
  ensureDataDir, ensureGroup, loadConfig, loadGroups, readHeartbeat, resolveGroup,
} from "../src/core/config.mjs"

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OPENCODE_DIR = join(homedir(), ".config", "opencode")
const PLUGIN_DIR = join(OPENCODE_DIR, "plugins", "agent-memory")
const PLUGIN_DEST = join(OPENCODE_DIR, "plugins", "agent-memory.js")
const COMMAND_DEST = join(OPENCODE_DIR, "command", "mem.md")

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function age(ts) {
  if (!ts) return "从未"
  const d = Date.now() - ts
  if (d < 60_000) return `${Math.round(d / 1000)} 秒前`
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`
  return `${Math.round(d / 86_400_000)} 天前`
}

async function cmdInit() {
  ensureDataDir()
  const cfg = loadConfig()
  const groups = loadGroups()
  const { db, driverName } = await openDb(DB_PATH)
  const m = await migrate(db)
  kvSet(db, "schema_version", String(m.to))
  for (const g of groups.groups || []) {
    ensureGroup(db, { id: g.id, name: g.name || g.id, kind: "manual", pattern: (g.paths || [])[0] || null })
  }
  db.close()

  console.log(C.bold("agent-memory 初始化完成"))
  console.log(`  数据目录  ${DATA_DIR}`)
  console.log(`  数据库    ${DB_PATH} ${C.dim(m.applied ? `(schema v${m.to} 已创建)` : `(schema v${m.to} 已存在)`)}`)
  console.log(`  配置      ${CONFIG_PATH}`)
  console.log(`  记忆组    ${GROUPS_PATH} ${C.dim(`(${groups.groups.length} 个)`)}`)
  console.log(`  驱动      ${driverName}`)
  console.log()
  console.log(C.dim("下一步：node bin/mem.mjs install   # 把插件装进 OpenCode"))
}

async function cmdDoctor() {
  const cfg = loadConfig()
  const { db, driverName } = await openDb(DB_PATH)
  await migrate(db)

  const size = [DB_PATH, DB_PATH + "-wal"].filter(existsSync).reduce((n, f) => n + statSync(f).size, 0)
  const stats = dbStats(db)
  const hb = readHeartbeat()
  const groups = db.prepare("SELECT id, name, kind FROM memory_groups ORDER BY created_at").all()
  const events = db.prepare("SELECT action, created_at FROM memory_events ORDER BY id DESC LIMIT 5").all()

  const hbAge = hb?.at ? Date.now() - hb.at : null
  const hbState =
    hbAge === null ? C.yellow("未上报（插件未加载？）") : hbAge < 10 * 60_000 ? C.green("在线") : C.red(age(hb.at))

  console.log(C.bold("agent-memory doctor"))
  console.log(`  宿主          ${hb?.host || "-"} ${hb?.runtime || ""}`)
  console.log(`  插件          ${existsSync(PLUGIN_DEST) ? C.green("已安装") : C.yellow("未安装")} ${C.dim(PLUGIN_DEST)}`)
  console.log(`  心跳          ${hbState} ${C.dim(hb?.lastInjectedAt ? `上次注入 ${age(hb.lastInjectedAt)}` : "")}`)
  console.log(`  提炼模型      ${cfg.capture.providerID}/${cfg.capture.modelID}`)
  console.log(`  上次捕获      ${age(hb?.lastCaptureAt)} ${C.dim(hb?.lastCaptureSession ? `(${hb.lastCaptureSession})` : "")}`)
  console.log(`  驱动          ${driverName}`)
  console.log(`  数据库        ${DB_PATH}`)
  console.log(`  体积          ${fmtBytes(size)} ${C.dim(`/ 软预算 ${cfg.budget.softMb} MB`)}`)
  console.log(`  记忆          promoted ${stats.promoted} · draft ${stats.drafts} · conflicted ${stats.conflicted} · archived ${stats.archived}`)
  const stateCount = db.prepare("SELECT COUNT(*) AS n FROM group_state").get()?.n ?? 0
  const sessionStateCount = db.prepare("SELECT COUNT(*) AS n FROM session_state").get()?.n ?? 0
  console.log(`  当前状态      ${stateCount} 项组级 · ${sessionStateCount} 项会话级（覆盖写）`)

  const day = 86400_000
  const nowTs = Date.now()
  const stale = db
    .prepare(
      `SELECT content, kind, COALESCE(last_seen_at, updated_at) AS seen
       FROM memories
       WHERE status='promoted' AND valid_to IS NULL AND COALESCE(last_seen_at, updated_at) < ?
       ORDER BY seen LIMIT 8`
    )
    .all(nowTs - 90 * day)
  const statusStale = db
    .prepare(
      `SELECT content, kind, COALESCE(last_seen_at, updated_at) AS seen
       FROM memories
       WHERE status='promoted' AND valid_to IS NULL AND kind IN ('progress','summary')
         AND COALESCE(last_seen_at, updated_at) < ?
       ORDER BY seen LIMIT 8`
    )
    .all(nowTs - 30 * day)
  const unresolved = db
    .prepare(
      `SELECT id, content, updated_at FROM memories
       WHERE status='conflicted' AND updated_at < ? ORDER BY updated_at LIMIT 8`
    )
    .all(nowTs - 7 * day)
  if (stale.length || statusStale.length || unresolved.length) {
    console.log("  待复核")
    for (const m of statusStale) {
      console.log(`                ${C.yellow("状态")} ${C.dim(`${Math.round((nowTs - m.seen) / day)} 天未确认`)} ${m.content.slice(0, 60)}`)
    }
    for (const m of stale) {
      if (statusStale.some((x) => x.content === m.content)) continue
      console.log(`                ${C.dim("长期")} ${C.dim(`${Math.round((nowTs - m.seen) / day)} 天未确认`)} ${m.content.slice(0, 60)}`)
    }
    for (const m of unresolved) {
      console.log(`                ${C.red("冲突")} ${C.dim(`${Math.round((nowTs - m.updated_at) / day)} 天未处理`)} ${m.content.slice(0, 60)}`)
    }
  }
  console.log(`  图谱          ${stats.entities} 节点 / ${stats.edges} 边`)
  console.log(`  记忆组        ${stats.groups} 个`)
  for (const g of groups) console.log(`                ${C.dim(g.id)} ${g.name} ${C.dim(`(${g.kind})`)}`)
  if (events.length) {
    console.log("  最近事件")
    for (const e of events) console.log(`                ${age(e.created_at)}  ${e.action}`)
  }
  if (hb?.capabilities) {
    console.log("  宿主能力")
    for (const [k, v] of Object.entries(hb.capabilities)) {
      console.log(`                ${v ? C.green("✓") : C.red("✗")} ${k}`)
    }
  }
  db.close()

  if (hbAge !== null && hbAge > 48 * 3600_000) {
    console.log()
    console.log(C.yellow("⚠ 超过 48 小时没有心跳：宿主可能更新过，或插件被禁用。"))
  }
}

async function cmdServe(argv) {
  const { startServer } = await import("../src/ui/server.mjs")
  const cfg = loadConfig()
  const port = Number(argv.port || cfg.ui.port)
  const host = argv.host || cfg.ui.host
  const { url, close } = await startServer({ host, port })
  console.log(C.bold("agent-memory 管理后台"))
  console.log(`  ${url}`)
  console.log(C.dim("  Ctrl+C 退出"))
  const stop = async () => {
    await close()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

function cmdInstall() {
  ensureDataDir()
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version
  writeFileSync(
    join(DATA_DIR, "install.json"),
    JSON.stringify({ root: ROOT, version, installedAt: Date.now() }, null, 2) + "\n"
  )
  rmSync(PLUGIN_DIR, { recursive: true, force: true }) // 旧目录形态，避免双载
  rmSync(PLUGIN_DEST, { recursive: true, force: true })
  mkdirSync(join(OPENCODE_DIR, "plugins"), { recursive: true })
  cpSync(join(ROOT, "plugin", "index.js"), PLUGIN_DEST)

  mkdirSync(dirname(COMMAND_DEST), { recursive: true })
  writeFileSync(
    COMMAND_DEST,
    `---
description: agent-memory 记忆系统（查看状态 / 打开后台 / 搜索记忆）
---

用户请求：$ARGUMENTS

agent-memory 的独立 CLI 在 \`${join(ROOT, "bin", "mem.mjs")}\`。

- 查看状态：\`node "${join(ROOT, "bin", "mem.mjs")}" doctor\`
- 打开后台：\`node "${join(ROOT, "bin", "mem.mjs")}" serve\`（然后浏览器访问 http://127.0.0.1:4780）
- 搜索记忆：\`node "${join(ROOT, "bin", "mem.mjs")}" sql "select ..."\`

按用户请求执行对应命令，并把关键输出如实转述。不要编造记忆内容。
`
  )
  console.log(C.bold("插件已安装"))
  console.log(`  ${PLUGIN_DEST}`)
  console.log(`  ${COMMAND_DEST}`)
  console.log(C.yellow("重启 OpenChamber 后生效。"))
}

async function cmdIngest(argv, flags) {
  const raw = flags.file ? readFileSync(flags.file, "utf8") : readFileSync(0, "utf8")
  const payload = parsePayload(raw)
  const candidates = payload.items
  const dir = flags.dir || process.cwd()
  const group = flags.group
    ? { id: flags.group, name: flags.group, kind: "manual" }
    : resolveGroup(dir)
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const r = ingestCandidates(db, {
    group, dir, sessionID: flags.session, candidates,
    decisions: payload.decisions, summary: payload.summary,
  })
  db.close()
  process.stdout.write(JSON.stringify(r) + "\n")
}

async function cmdAction(action, id) {
  if (!id) { console.error("缺少 memory id"); process.exit(2) }
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const fn = {
    promote: promoteMemory, demote: demoteMemory, forget: forgetMemory, restore: restoreMemory,
    pin: (d, i, a) => pinMemory(d, i, true, a),
    unpin: (d, i, a) => pinMemory(d, i, false, a),
  }[action]
  const ok = fn(db, id, "user")
  db.close()
  console.log(ok ? `${action} ok: ${id}` : `未找到: ${id}`)
  if (!ok) process.exit(1)
}

async function cmdList(flags) {
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const rows = listMemories(db, {
    groupID: flags.group,
    status: flags.status,
    query: flags.query,
    limit: Number(flags.limit || 20),
    offset: Number(flags.offset || 0),
  })
  const total = rows.total
  if (!rows.length) console.log(C.dim("(空)"))
  for (const m of rows) {
    const mark = { promoted: "●", draft: "○", conflicted: "!", archived: "×" }[m.status] || "?"
    console.log(`${mark} ${C.dim(m.group_id)} ${C.dim(m.kind)} ${m.content}`)
    console.log(`  ${C.dim(m.id)} ${C.dim(m.status)} conf=${m.confidence} hits=${m.hits}`)
  }
  console.log(C.dim(`共 ${total} 条，显示 ${rows.length}`))
  db.close()
}

async function cmdContext(flags) {
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const text = buildContext(db, {
    groupID: flags.group,
    sessionID: flags.session || "",
    query: flags.query || flags.q || "",
    budgetChars: flags.budget ? Number(flags.budget) : undefined,
  })
  if (flags.json) process.stdout.write(JSON.stringify({ group: flags.group, text }) + "\n")
  else process.stdout.write(text + (text ? "\n" : ""))
  db.close()
}

async function cmdExport(flags) {
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const groupID = flags.group || null
  const rows = db
    .prepare(
      `SELECT m.*, g.name AS group_name FROM memories m LEFT JOIN memory_groups g ON g.id = m.group_id
       WHERE m.status='promoted' AND m.valid_to IS NULL ${groupID ? "AND m.group_id=?" : ""}
       ORDER BY m.group_id, m.kind, m.pinned DESC, m.updated_at DESC`
    )
    .all(...(groupID ? [groupID] : []))
  const labels = { decision: "决策", pitfall: "踩坑", progress: "进度", summary: "摘要", reference: "资料", preference: "偏好", procedure: "做法" }
  const stateByGroup = new Map()
  for (const r of db.prepare("SELECT * FROM group_state ORDER BY group_id, key").all()) {
    if (!stateByGroup.has(r.group_id)) stateByGroup.set(r.group_id, [])
    stateByGroup.get(r.group_id).push(r)
  }
  const lines = ["# agent-memory 导出", "", `> ${new Date().toISOString()} · ${rows.length} 条生效记忆`, ""]
  let currentGroup = null
  let currentKind = null
  for (const r of rows) {
    if (r.group_id !== currentGroup) {
      currentGroup = r.group_id
      currentKind = null
      lines.push(`## ${r.group_name || r.group_id}`, "")
      const states = stateByGroup.get(r.group_id)
      if (states) {
        lines.push("### 当前状态", "")
        for (const st of states) lines.push(`- ${STATE_LABELS[st.key] || st.key}：${st.value}`)
        lines.push("")
      }
    }
    if (r.kind !== currentKind) {
      currentKind = r.kind
      lines.push(`### ${labels[r.kind] || r.kind}`, "")
    }
    const src = (() => { try { return JSON.parse(r.source_json || "{}") } catch { return {} } })()
    const bits = [`置信 ${Math.round(r.confidence * 100)}%`]
    if (r.hits) bits.push(`命中 ${r.hits}`)
    if (r.pinned) bits.push("置顶")
    if (r.valid_from) bits.push(`生效 ${new Date(r.valid_from).toISOString().slice(0, 10)}`)
    lines.push(`- ${r.content}  `)
    lines.push(`  <sub>${bits.join(" · ")}${src.session_id ? ` · 来源 ${src.session_id}` : ""}</sub>`)
    if (r.detail) {
      const detail = String(r.detail).split("\n").map((x) => `  ${x}`).join("\n")
      lines.push(detail)
    }
  }
  const text = lines.join("\n") + "\n"
  if (flags.stdout) {
    process.stdout.write(text)
    db.close()
    return
  }
  const outDir = join(DATA_DIR, "exports")
  mkdirSync(outDir, { recursive: true })
  const name = `memory-${groupID || "all"}-${new Date().toISOString().slice(0, 10)}.md`
  const out = flags.out || join(outDir, name)
  writeFileSync(out, text, "utf8")
  db.close()
  console.log(out)
}

async function cmdUi(flags) {
  const cfg = loadConfig()
  const url = `http://${cfg.ui.host}:${cfg.ui.port}`
  let up = false
  try { up = (await fetch(url + "/health", { signal: AbortSignal.timeout(1500) })).ok } catch {}
  if (!up) {
    const child = spawn(process.execPath, [join(ROOT, "bin", "mem.mjs"), "serve"], {
      detached: true, stdio: "ignore", env: process.env, windowsHide: true,
    })
    child.unref()
    for (let i = 0; i < 20 && !up; i++) {
      await new Promise((r) => setTimeout(r, 300))
      try { up = (await fetch(url + "/health", { signal: AbortSignal.timeout(1000) })).ok } catch {}
    }
  }
  console.log(C.bold("agent-memory 管理后台"))
  console.log("  " + url)
  if (flags["no-open"]) return
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]]
  spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  console.log(C.dim("  已在默认浏览器打开；没有自动打开就手动复制上面的地址"))
}

async function cmdMaintain() {
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const r = runMaintenance(db, loadConfig())
  db.close()
  console.log(JSON.stringify(r))
}

async function cmdShow(id) {
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const m = getMemory(db, id)
  db.close()
  if (!m) { console.error("未找到: " + id); process.exit(1) }
  console.log(JSON.stringify(m, null, 2))
}

async function cmdApi(argv, flags) {
  const sub = argv[0]
  const { db, driverName } = await openDb(DB_PATH)
  await migrate(db)
  const out = (v) => { process.stdout.write(JSON.stringify(v)); process.stdout.write("\n") }
  try {
    switch (sub) {
      case "status":
        const size = [DB_PATH, DB_PATH + "-wal"].filter(existsSync).reduce((n, f) => n + statSync(f).size, 0)
        out({
          stats: dbStats(db),
          groups: groupsView(db),
          heartbeat: readHeartbeat(),
          budget: loadConfig().budget,
          capture: loadConfig().capture,
          size,
          driver: driverName,
        })
        break
      case "list": {
        const rows = listMemories(db, {
          groupID: flags.group, status: flags.status, kind: flags.kind,
          query: flags.q || flags.query, sort: flags.sort,
          limit: Number(flags.limit || 50), offset: Number(flags.offset || 0),
        })
        out({ rows, total: rows.total })
        break
      }
      case "groups":
        out({ groups: groupsView(db) })
        break
      case "action": {
        const [action, id, other] = argv.slice(1)
        if (action === "supersede") {
          out({ ok: supersedeMemory(db, id, other, "panel") })
          break
        }
        if (action === "pin" || action === "unpin") {
          out({ ok: pinMemory(db, id, action === "pin", "panel") })
          break
        }
        const fn = { promote: promoteMemory, demote: demoteMemory, forget: forgetMemory, restore: restoreMemory }[action]
        out({ ok: Boolean(fn) && fn(db, id, "panel") })
        break
      }
      case "edit": {
        const id = argv[1]
        out({ ok: updateMemory(db, id, { content: flags.content, detail: flags.detail }, "panel") })
        break
      }
      case "maintain":
        out(runMaintenance(db, loadConfig()))
        break
      case "memory": {
        const m = getMemory(db, argv[1])
        out(m ? m : { error: "not found" })
        break
      }
      case "events": {
        const limit = Number(flags.limit || 200)
        const rows = flags.group
          ? db.prepare("SELECT * FROM memory_events WHERE group_id = ? ORDER BY id DESC LIMIT ?").all(flags.group, limit)
          : db.prepare("SELECT * FROM memory_events ORDER BY id DESC LIMIT ?").all(limit)
        out({ rows })
        break
      }
      case "stats":
        out({
          stats: dbStats(db),
          rollups: db.prepare("SELECT * FROM event_rollups ORDER BY day DESC LIMIT 100").all(),
        })
        break
      case "graph":
        out(graphData(db, flags.group || null))
        break
      case "group-save": {
        const paths = String(flags.paths || "").split("|").map((x) => x.trim()).filter(Boolean)
        out(saveGroup({ id: flags.id, name: flags.name, paths }))
        break
      }
      case "resolve": {
        const [keep, drop] = argv.slice(1)
        out({ ok: resolveConflict(db, keep, drop, "panel") })
        break
      }
      case "related": {
        const node = `memory:${argv[1]}`
        const edges = db.prepare("SELECT src, predicate, dst FROM edges WHERE src = ? OR dst = ?").all(node, node)
        const seen = new Set()
        const items = []
        for (const e of edges) {
          const other = e.src === node ? e.dst : e.src
          if (seen.has(other)) continue
          seen.add(other)
          const ent = db.prepare("SELECT id, type, name FROM entities WHERE id = ?").get(other)
          const mem = other.startsWith("memory:") ? db.prepare("SELECT id, content, status FROM memories WHERE id = ?").get(other.slice(7)) : null
          items.push({
            id: other,
            type: ent?.type || "unknown",
            label: (mem?.content || ent?.name || other).slice(0, 60),
            predicate: e.predicate,
            memoryId: mem?.id || null,
            status: mem?.status || null,
          })
        }
        out({ items })
        break
      }
      case "backup":
        out(backupDb(db))
        break
      case "conflicts": {
        const rows = db.prepare("SELECT src, dst FROM edges WHERE predicate='conflicts' LIMIT 200").all()
        const seen = new Set()
        const pairs = []
        for (const r of rows) {
          const a = r.src.replace(/^memory:/, "")
          const b = r.dst.replace(/^memory:/, "")
          const key = [a, b].sort().join("|")
          if (seen.has(key)) continue
          seen.add(key)
          const ma = db.prepare("SELECT id, content, status, kind, group_id FROM memories WHERE id=?").get(a)
          const mb = db.prepare("SELECT id, content, status, kind, group_id FROM memories WHERE id=?").get(b)
          if (ma && mb) pairs.push({ a: ma, b: mb })
        }
        out({ pairs })
        break
      }
      case "state": {
        const group = flags.group || ""
        const session = flags.session || ""
        out({
          group: group || null,
          session: session || null,
          rows: session ? getSessionState(db, session) : getState(db, group),
          sessionScopes: session ? [] : listSessionStates(db, group),
        })
        break
      }
      case "state-set":
        out({
          ok: flags.session
            ? setSessionState(db, flags.group, flags.session, flags.key, flags.value, { by: "panel" })
            : setState(db, flags.group, flags.key, flags.value, { by: "panel" }),
        })
        break
      case "state-clear":
        out({
          ok: flags.session
            ? setSessionState(db, flags.group, flags.session, flags.key, "", { by: "panel" })
            : setState(db, flags.group, flags.key, "", { by: "panel" }),
        })
        break
      case "context":
        out({
          text: buildContext(db, {
            groupID: flags.group,
            sessionID: flags.session || "",
            query: flags.query || flags.q || "",
            budgetChars: flags.budget ? Number(flags.budget) : undefined,
          }),
        })
        break
      default:
        out({ error: "unknown api: " + sub })
    }
  } finally {
    db.close()
  }
}

async function cmdState(argv, flags) {
  const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list"
  const session = flags.session || ""
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  try {
    if (sub === "set") {
      const group = argv[1] || flags.group
      const key = argv[2] || flags.key
      const value = argv.slice(3).join(" ") || flags.value || ""
      if (!group || !key) { console.error("用法: mem state set <group> <key> <value> [--session S]"); process.exit(2) }
      if (session) setSessionState(db, group, session, key, value, { by: "user" })
      else setState(db, group, key, value, { by: "user" })
      console.log(`${STATE_LABELS[key] || key} 已更新${session ? `（会话 ${session}）` : ""}`)
      return
    }
    if (sub === "clear") {
      const group = argv[1] || flags.group
      const key = argv[2] || flags.key
      if (!group || !key) { console.error("用法: mem state clear <group> <key> [--session S]"); process.exit(2) }
      if (session) setSessionState(db, group, session, key, "", { by: "user" })
      else setState(db, group, key, "", { by: "user" })
      console.log("已清空")
      return
    }
    const group = argv[1] || flags.group
    if (!group) { console.error("用法: mem state list <group> [--session S]"); process.exit(2) }
    const rows = session ? getSessionState(db, session) : getState(db, group)
    const scopes = session ? [] : listSessionStates(db, group)
    if (!rows.length && !scopes.length) { console.log(C.dim("(空)")); return }
    if (rows.length) {
      console.log(C.bold(session ? `会话 ${session} 当前状态` : `组 ${group} 组级状态`))
      for (const r of rows) {
        console.log(`  ${STATE_LABELS[r.key] || r.key}：${r.value} ${C.dim(`(${age(r.updated_at)}, ${r.updated_by})`)}`)
      }
    }
    if (scopes.length) {
      console.log(C.dim("\n会话级状态（摘要自动写，只影响该会话）："))
      for (const s of scopes) {
        console.log(`  ${C.dim(s.session_id.slice(0, 14))} ${s.rows.map((r) => `${STATE_LABELS[r.key] || r.key}=${r.value}`).join(" · ")}`)
      }
    }
  } finally {
    db.close()
  }
}

async function cmdSql(args) {
  const sql = args.join(" ").trim()
  if (!sql) {
    console.error("用法: mem sql \"select ...\"")
    process.exit(2)
  }
  const { db } = await openDb(DB_PATH)
  await migrate(db)
  const stmt = db.prepare(sql)
  const rows = /^\s*select/i.test(sql) ? stmt.all() : [stmt.run()]
  if (!rows.length) console.log(C.dim("(no rows)"))
  else console.table(rows)
  db.close()
}

function cmdUninstall() {
  rmSync(PLUGIN_DEST, { force: true })
  rmSync(PLUGIN_DIR, { recursive: true, force: true })
  rmSync(COMMAND_DEST, { force: true })
  console.log("插件已移除；数据保留在 " + DATA_DIR)
}

function usage() {
  console.log(`mem — agent-memory

用法:
  mem init                初始化数据目录、配置、数据库
  mem doctor              体检（宿主、插件、DB、心跳、能力）
  mem ui                  启动后台并打开浏览器
  mem serve [--port N]    启动本地管理后台（前台阻塞）
  mem install             安装 OpenCode 插件 + /mem 命令
  mem uninstall           移除插件（保留数据）
  mem ingest --file F     把提炼结果写入草稿区（F 为 JSON 数组，或 stdin）
  mem list                列出记忆（--group --status --query --limit）
  mem promote|demote|forget|restore <id>
  mem state list <group>   查看当前状态（status / next / blocker）
  mem state set <group> <key> <value>
  mem state clear <group> <key>
  mem context --group G   输出该组的注入上下文（--query 相关度检索，--budget 字符上限）
  mem pin|unpin <id>      置顶 / 取消置顶（置顶必注入）
  mem supersede <旧> <新> 新记忆取代旧记忆（旧记忆保留但失效）
  mem export [--group G] [--out F] [--stdout]
                          导出 Markdown（可读、可备份、可交给别的工具）
  mem maintain            跑一次存储治理
  mem show <id>           查看单条记忆与事件
  mem sql "<query>"       直接查询数据库
  mem groups              列出记忆组与解析结果

环境变量:
  AGENT_MEMORY_DIR        覆盖数据目录（默认 ~/.agent-memory）
`)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (rest[i + 1] && !rest[i + 1].startsWith("--")) {
      flags[a.slice(2)] = rest[++i]
    } else {
      flags[a.slice(2)] = true
    }
  }
  switch (cmd) {
    case "init": return cmdInit()
    case "doctor": return cmdDoctor()
    case "serve": return cmdServe(flags)
    case "install": return cmdInstall()
    case "uninstall": return cmdUninstall()
    case "ingest": return cmdIngest(rest, flags)
    case "promote": case "demote": case "forget": case "restore":
      return cmdAction(cmd, rest.find((a) => !a.startsWith("--")))
    case "pin": case "unpin":
      return cmdAction(cmd, rest.find((a) => !a.startsWith("--")))
    case "supersede": {
      const ids = rest.filter((a) => !a.startsWith("--"))
      if (ids.length < 2) { console.error("用法: mem supersede <旧 id> <新 id>"); process.exit(2) }
      const { db } = await openDb(DB_PATH)
      await migrate(db)
      const ok = supersedeMemory(db, ids[0], ids[1], "user")
      db.close()
      console.log(ok ? `supersede ok: ${ids[0]} -> ${ids[1]}` : "未找到记忆")
      if (!ok) process.exit(1)
      return
    }
    case "state": return cmdState(rest, flags)
    case "list": return cmdList(flags)
    case "context": return cmdContext(flags)
    case "export": return cmdExport(flags)
    case "maintain": return cmdMaintain()
    case "api": return cmdApi(rest.filter((a) => !a.startsWith("--") && !flags[a.replace(/^--/, "")]), flags)
    case "ui": return cmdUi(flags)
    case "show": return cmdShow(rest.find((a) => !a.startsWith("--")))
    case "sql": return cmdSql(rest.filter((a) => !a.startsWith("--")))
    case "groups": {
      const g = loadGroups()
      console.log(JSON.stringify(g, null, 2))
      const resolved = resolveGroup(process.cwd(), g)
      console.log(C.dim(`当前目录 → ${resolved.id} (${resolved.name}, ${resolved.kind})`))
      return
    }
    default:
      usage()
      if (cmd && cmd !== "help" && cmd !== "--help") process.exit(2)
  }
}

main().catch((err) => {
  console.error(C.red("错误: ") + (err?.stack || err))
  process.exit(1)
})
