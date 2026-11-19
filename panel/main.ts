// agent-memory 面板：侧栏里的完整记忆管理界面。
import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import cytoscape from "cytoscape"
import { forceSimulation, forceLink, forceManyBody, forceCollide, forceX, forceY } from "d3-force"

const PREVIEW = typeof location !== "undefined" && new URLSearchParams(location.search).has("preview")

function previewHost() {
  const now = Date.now()
  const rows = [
    { id: "m1", group_id: "protocol", kind: "decision", status: "promoted", pinned: 1, content: "生成的构建产物放 out/，不要提交到仓库根目录", detail: null, source_json: JSON.stringify({ session_id: "ses_a1", dir: "D:/work/protocol-fuzzing", evidence: "keep generated files out of the repo" }), confidence: 0.9, hits: 4, created_at: now - 86400000, updated_at: now - 3600000, events: [] },
    { id: "m2", group_id: "protocol", kind: "pitfall", status: "draft", content: "夜间任务必须显式设置 TZ=UTC，否则统计跨天", detail: null, source_json: JSON.stringify({ session_id: "ses_a1", dir: "D:/work/protocol-fuzzing", evidence: "counts rolled over at midnight local time" }), confidence: 0.8, hits: 1, created_at: now - 7200000, updated_at: now - 7200000, events: [] },
    { id: "m3", group_id: "protocol", kind: "preference", status: "draft", content: "响应时间用表格汇报，不要写成段落", detail: null, source_json: JSON.stringify({ session_id: "ses_a2", dir: "D:/work/protocol-fuzzing", evidence: "tables are easier to compare" }), confidence: 0.95, hits: 0, created_at: now - 5400000, updated_at: now - 5400000, last_seen_at: now - 5400000, events: [] },
    { id: "m4", group_id: "protocol", kind: "summary", status: "promoted", content: "状态层完成；下一步：冲突裁决", detail: null, source_json: JSON.stringify({ session_id: "ses_a3", dir: "D:/work/protocol-fuzzing" }), confidence: 0.8, hits: 1, created_at: now - 20 * 86400000, updated_at: now - 20 * 86400000, last_seen_at: now - 20 * 86400000, events: [] },
  ]
  const groups = [
    { id: "protocol", name: "协议模糊测试", kind: "manual", n: 3, paths: ["D:/work/protocol-fuzzing/**"] },
    { id: "papers", name: "论文与项目材料", kind: "manual", n: 0, paths: ["D:/work/papers"] },
  ]
  const flat = (p: string) => p.split("?")[0]
  const data: Record<string, any> = {
    "/status": {
      stats: { promoted: 1, drafts: 2, conflicted: 0, archived: 0, memories: 3, entities: 10, edges: 11, events: 9, groups: 2 },
      groups,
      heartbeat: { at: now - 12000, lastIdleAt: now - 3600000, lastCaptureAt: now - 3540000, host: "opencode-v2" },
      capture: { enabled: true, providerID: "small", modelID: "small-model" },
      budget: { softMb: 200, hardMb: 500 },
      size: 102400,
      driver: "node:sqlite",
    },
    "/list": { rows, total: rows.length },
    "/events": { rows: [
      { id: 1, action: "promote", group_id: "protocol", actor: "user", created_at: now - 3600000 },
      { id: 2, action: "capture", group_id: "protocol", actor: "plugin", created_at: now - 7200000 },
      { id: 3, action: "conflict", group_id: "protocol", actor: "plugin", created_at: now - 86400000 },
    ]},
    "/conflicts": { pairs: [] },
    "/graph": { nodes: [
      { id: "memory:m1", type: "memory", label: "实验目录用 tools/agent-memory", status: "promoted" },
      { id: "memory:m2", type: "memory", label: "opencode-go 额度会耗尽", status: "draft" },
      { id: "group:protocol", type: "group", label: "协议模糊测试" },
      { id: "topic:agent-memory", type: "topic", label: "agent-memory" },
      { id: "topic:目录结构", type: "topic", label: "目录结构" },
      { id: "session:ses_a1", type: "session", label: "ses_a1" },
    ], edges: [
      { src: "memory:m1", predicate: "belongs_to", dst: "group:protocol" },
      { src: "memory:m1", predicate: "about", dst: "topic:agent-memory" },
      { src: "memory:m1", predicate: "about", dst: "topic:目录结构" },
      { src: "memory:m1", predicate: "from_session", dst: "session:ses_a1" },
      { src: "memory:m2", predicate: "belongs_to", dst: "group:protocol" },
      { src: "memory:m2", predicate: "about", dst: "topic:agent-memory" },
    ]},
    "/groups": { groups },
    "/state": { group: "protocol", rows: [
      { key: "status", value: "正在实现 P0 状态层", updated_at: now - 3600000, updated_by: "user", source_memory_id: null, last_injected_at: now - 600000 },
    ], sessionScopes: [
      { session_id: "ses_a2", updated_at: now - 7200000, last_injected_at: now - 900000, rows: [
        { key: "next", value: "接 P1 冲突裁决", updated_at: now - 7200000, updated_by: "summary", last_injected_at: now - 900000 },
      ]},
    ]},
    "/state-set": { ok: true },
    "/state-clear": { ok: true },
    "/stats": { stats: { memories: 3, promoted: 1, drafts: 2, archived: 0 }, rollups: [] },
    "/memory": { ...rows[0], events: [{ action: "capture", actor: "plugin", created_at: now - 86400000 }] },
    "/related": { items: [{ id: "topic:agent-memory", type: "topic", label: "agent-memory", predicate: "about" }] },
    "/maintain": { expiredDrafts: 0, archived: 0 },
    "/backup": { size: 102400 },
    "/group-save": { ok: true },
  }
  const seeded = (window as any).__PREVIEW_GRAPH
  if (seeded) data["/graph"] = seeded
  const ocProjects = [
    { id: "protocol", name: "协议模糊测试", directory: "D:/work/protocol-fuzzing" },
    { id: "papers", name: "论文与项目材料", directory: "D:/work/papers" },
  ]
  const ocSessions = [
    { id: "ses_a1", title: "捕获链路修复", projectId: "protocol", directory: "D:/work/protocol-fuzzing", updatedAt: now - 3600000 },
    { id: "ses_a2", title: "状态层实现", projectId: "protocol", directory: "D:/work/protocol-fuzzing", updatedAt: now - 7200000 },
    { id: "ses_b1", title: "论文结构梳理", projectId: "papers", directory: "D:/work/papers", updatedAt: now - 86400000 },
  ]
  return {
    onReady(cb: any) { setTimeout(() => cb({}), 0) },
    async listProjects() { return { state: "ready", projects: ocProjects } },
    async listSessions(projectId: string) {
      return { state: "ready", sessions: ocSessions.filter((x) => !projectId || x.projectId === projectId) }
    },
    async serviceRequest(req: any) {
      if (flat(req.path) === "/graph") {
        const u = new URL(req.path, "http://x")
        if (u.searchParams.get("group") === "papers") return { status: 200, body: JSON.stringify({ nodes: [], edges: [] }) }
      }
      if (flat(req.path) === "/memory") {
        const u = new URL(req.path, "http://x")
        const id = u.searchParams.get("id")
        const row = rows.find((r) => r.id === id) || rows[0]
        return { status: 200, body: JSON.stringify({ ...row, events: [{ action: "capture", actor: "plugin", created_at: now - 86400000 }] }) }
      }
      if (flat(req.path) === "/list") {
        const u = new URL(req.path, "http://x")
        const status = u.searchParams.get("status")
        const out = status ? rows.filter((r) => r.status === status) : rows
        return { status: 200, body: JSON.stringify({ rows: out, total: out.length }) }
      }
      return { status: 200, body: JSON.stringify(data[flat(req.path)] ?? {}) }
    },
  } as any
}

const host = PREVIEW ? previewHost() : connectHost()
const root = document.getElementById("root") as HTMLElement

type View = "overview" | "drafts" | "memories" | "state" | "conflicts" | "graph" | "groups" | "events" | "stats"

type Row = {
  id: string
  group_id: string
  kind: string
  status: string
  content: string
  detail: string | null
  source_json: string
  confidence: number
  hits: number
  created_at: number
  updated_at: number
  last_seen_at?: number | null
  last_injected_at?: number | null
  valid_from?: number | null
  valid_to?: number | null
  pinned?: number
  events?: any[]
}

type Group = { id: string; name: string; kind: string; n: number; paths: string[] }
type Status = {
  stats: { promoted: number; drafts: number; conflicted: number; archived: number; memories: number; entities: number; edges: number; events: number; groups: number }
  groups: Group[]
  heartbeat: any
  capture?: { enabled?: boolean; providerID?: string; modelID?: string }
  budget: { softMb: number; hardMb: number }
  size: number
  driver: string
}

function seedHash(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967295
}

function loadForces() {
  const def = { center: 90, repel: 25, link: 90, distance: 35, labels: 45 }
  try {
    const f = JSON.parse(localStorage.getItem("am.forces") || "{}")
    return {
      center: Number.isFinite(f?.center) ? f.center : def.center,
      repel: Number.isFinite(f?.repel) ? f.repel : def.repel,
      link: Number.isFinite(f?.link) ? f.link : def.link,
      distance: Number.isFinite(f?.distance) ? f.distance : def.distance,
      labels: Number.isFinite(f?.labels) ? f.labels : def.labels,
    }
  } catch {
    return def
  }
}

const S = {
  view: "overview" as View,
  status: null as Status | null,
  rows: [] as Row[],
  total: 0,
  offset: 0,
  filters: { q: "", group: "", status: "", kind: "", sort: "updated" },
  events: [] as any[],
  eventGroup: "",
  pairs: [] as any[],
  graph: null as any,
  graphData: null as any,
  eventAction: "",
  stateGroup: "",
  graphLayout: "cose",
  graphTypes: new Set(["memory", "group", "topic", "session", "file"]),
  graphFocus: null as string | null,
  graphSearch: "",
  graphRO: null as any,
  forces: loadForces() as { center: number; repel: number; link: number; distance: number; labels: number },
  sim: null as any,
  simNodes: new Map<string, any>(),
  layoutJob: null as any,
  toastTimer: 0 as any,
}

let mounted = false
let main: HTMLElement
let pageHead: HTMLElement
let sheet: HTMLElement
let backdrop: HTMLElement
let toastEl: HTMLElement

/* ── 工具 ─────────────────────────────────────────────────────────── */
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))

const fmtAgo = (ts?: number | null) => {
  if (!ts) return "从未"
  const d = Math.max(0, Date.now() - ts)
  if (d < 60_000) return "刚刚"
  if (d < 3_600_000) return `${Math.round(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} 小时前`
  return `${Math.round(d / 86_400_000)} 天前`
}

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })

const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

const KIND: Record<string, string> = {
  decision: "决策", pitfall: "踩坑", progress: "进度", reference: "资料",
  preference: "偏好", procedure: "做法", summary: "摘要",
}

const STATUS: Record<string, { label: string; tone: string }> = {
  promoted: { label: "已生效", tone: "success" },
  draft: { label: "草稿", tone: "warning" },
  conflicted: { label: "冲突", tone: "error" },
  archived: { label: "归档", tone: "" },
}

const ACTION_LABEL: Record<string, string> = {
  capture: "捕获", promote: "晋升", demote: "降级", forget: "遗忘", restore: "恢复",
  conflict: "冲突", archive: "归档", expire: "过期", backup: "备份", maintain: "维护",
  duplicate_hit: "重复命中", group_create: "建组", group_edit: "改组",
  resolve: "裁决", resolve_dropped: "裁决归档",
  merge: "合并", merge_draft: "合并草稿", supersede: "取代", superseded: "被取代",
  auto_promote: "自动晋升", pin: "置顶", unpin: "取消置顶", budget_blocked: "预算拦截",
  summary: "会话摘要", summary_update: "摘要更新", judge: "模型裁决",
  state_set: "状态更新", state_clear: "状态清空",
}
const actionLabel = (a: string) => ACTION_LABEL[a] || a

const ICONS: Record<string, string> = {
  home: "M3 10.2 12 3l9 7.2V21h-6v-6H9v6H3z",
  draft: "M4 4h11l5 5v11H4zM15 4v6h6",
  layers: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  alert: "M12 3 2 21h20zM12 9v5M12 17.5v.5",
  graph: "M6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm12 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 6v12M8 6h8",
  folder: "M3 6h6l2 2h10v11H3z",
  activity: "M3 12h4l3-7 4 14 3-7h4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  refresh: "M20 11a8 8 0 1 0-2.3 6M20 4v7h-7",
  close: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm10 2-4.3-4.3",
  expand: "M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6",
  fit: "M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  star: "M12 3l2.7 5.9 6.3.7-4.7 4.3 1.3 6.1L12 17l-5.6 3 1.3-6.1L3 9.6l6.3-.7z",
  tune: "M4 7h5M13 7h7M4 12h9M17 12h3M4 17h3M11 17h9",
  state: "M5 6h14M5 12h14M5 18h9",
  inbox: "M3 13h5l1 2h6l1-2h5M3 13l3-9h12l3 9v7H3z",
}

const icon = (name: string, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.layers}"/></svg>`

const tag = (label: string, tone = "") => `<span class="tag ${tone}">${esc(label)}</span>`

function toast(message: string, kind: "ok" | "error" = "ok") {
  toastEl.textContent = message
  toastEl.className = "toast show" + (kind === "error" ? " error" : "")
  clearTimeout(S.toastTimer)
  S.toastTimer = setTimeout(() => (toastEl.className = "toast"), 2200)
}

/* ── 数据 ─────────────────────────────────────────────────────────── */
async function api(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<any> {
  const res = await host.serviceRequest({ method, path, body: body === undefined ? undefined : JSON.stringify(body) })
  if (res.status >= 400) throw new Error(res.body || "请求失败")
  return JSON.parse(res.body || "{}")
}

/* ── 壳 ───────────────────────────────────────────────────────────── */
function mount() {
  root.innerHTML = `
    <div class="topbar">
      <div class="brand">
        <span class="brand-mark">${icon("layers", 15)}</span>
        <div>
          <h1>Memory</h1>
          <div class="sub" id="sub">agent-memory</div>
        </div>
      </div>
      <div class="spacer"></div>
      <button class="btn icon ghost" id="refresh" title="刷新">${icon("refresh")}</button>
    </div>
    <div class="nav" id="nav"></div>
    <header class="page-head" id="page-head"></header>
    <div class="main" id="main"></div>
    <div class="sheet-backdrop" id="backdrop"></div>
    <aside class="sheet" id="sheet"></aside>
    <div class="toast" id="toast"></div>`

  main = document.getElementById("main") as HTMLElement
  pageHead = document.getElementById("page-head") as HTMLElement
  sheet = document.getElementById("sheet") as HTMLElement
  backdrop = document.getElementById("backdrop") as HTMLElement
  toastEl = document.getElementById("toast") as HTMLElement

  document.getElementById("refresh")?.addEventListener("click", () => void render())
  backdrop.addEventListener("click", closeSheet)

  bindDelegates()
  renderNav()
  void render()
}

const VIEW_META: Record<View, [string, string]> = {
  overview: ["总览", "本机的长期记忆与捕获状态"],
  drafts: ["草稿", "自动捕获的候选，晋升后才进入上下文"],
  memories: ["记忆", "生效、草稿与归档"],
  state: ["状态", "每组一行当前结论，覆盖写"],
  conflicts: ["冲突", "相似的新旧记忆，等人裁决"],
  graph: ["图谱", "记忆、主题与会话的连接"],
  groups: ["组", "按目录归档；可从 OpenChamber 直接选项目或会话"],
  events: ["事件", "捕获、晋升、裁决与维护"],
  stats: ["统计", "存储、类型与事件汇总"],
}

const NAV: [View, string, string][] = [
  ["overview", "总览", "home"],
  ["drafts", "草稿", "inbox"],
  ["memories", "记忆", "layers"],
  ["state", "状态", "state"],
  ["conflicts", "冲突", "alert"],
  ["graph", "图谱", "graph"],
  ["groups", "组", "folder"],
  ["events", "事件", "activity"],
  ["stats", "统计", "chart"],
]

function renderNav() {
  const nav = document.getElementById("nav") as HTMLElement
  nav.innerHTML = NAV.map(
    ([id, label]) =>
      `<button data-nav="${id}" class="${S.view === id ? "active" : ""}" ${S.view === id ? 'aria-current="page"' : ""}>${label}</button>`
  ).join("")
  nav.querySelectorAll("[data-nav]").forEach((el) =>
    el.addEventListener("click", () => {
      S.view = (el as HTMLElement).dataset.nav as View
      renderNav()
      void render()
    })
  )
}

function loading() {
  main.innerHTML = `<div class="sk-page">
    <div class="sk title"></div>
    <div class="sk card"></div>
    <div class="sk card"></div>
    <div class="sk row"></div>
  </div>`
}

function empty(text: string, ic = "inbox") {
  return `<div class="empty">${icon(ic, 22)}<div>${esc(text)}</div></div>`
}

/* ── 视图 ─────────────────────────────────────────────────────────── */
async function render() {
  root.dataset.view = S.view
  const [title, subtitle] = VIEW_META[S.view]
  pageHead.innerHTML = `<h2>${esc(title)}</h2><p>${esc(subtitle)}</p>`
  if (S.view !== "graph" && S.graph) {
    if (S.sim) {
      S.sim.stop()
      S.sim = null
    }
    S.graph.destroy()
    S.graph = null
  }
  if (S.view !== "graph" && S.graphRO) {
    S.graphRO.disconnect()
    S.graphRO = null
  }
  main.classList.toggle("graph-mode", S.view === "graph")
  loading()
  try {
    if (S.view === "overview") return await renderOverview()
    if (S.view === "drafts") return await renderList("draft")
    if (S.view === "memories") return await renderMemories()
    if (S.view === "state") return await renderState()
    if (S.view === "conflicts") return await renderConflicts()
    if (S.view === "graph") return await renderGraph()
    if (S.view === "groups") return await renderGroups()
    if (S.view === "events") return await renderEvents()
    if (S.view === "stats") return await renderStats()
  } catch (err) {
    main.innerHTML = empty("加载失败：" + (err as Error).message, "alert")
  }
}

async function loadStatus() {
  const st = (await api("/status")) as Status
  S.status = st
  const sub = document.getElementById("sub")
  if (sub) sub.textContent = `${st.groups.length} 组 · 仅本机`
  return st
}

async function renderOverview() {
  const [st, ev] = await Promise.all([loadStatus(), api("/events?limit=600")])
  const s = st.stats
  const hb = st.heartbeat
  const age = hb?.at ? Date.now() - hb.at : null
  const alive = age !== null && age < 10 * 60 * 1000
  const pctRaw = (st.size / (st.budget.softMb * 1024 * 1024)) * 100
  const pct = Math.min(100, Math.max(0, pctRaw))
  const pctLabel = pct > 0 && pct < 1 ? pct.toFixed(2) : String(Math.round(pct))
  const barClass = pct > 80 ? "danger" : pct > 50 ? "warn" : ""
  const ratio = s.memories ? Math.round((s.promoted / s.memories) * 100) : 0

  // 过去 14 天事件
  const now = new Date()
  const buckets = new Map<string, { n: number; promote: number }>()
  for (const e of ev.rows || []) {
    const d = new Date(e.created_at)
    const key = new Date(d.getFullYear(), d.getMonth(), d.getDate()).toDateString()
    const b = buckets.get(key) || { n: 0, promote: 0 }
    b.n++
    if (e.action === "promote") b.promote++
    buckets.set(key, b)
  }
  const days: { label: string; short: string; n: number; promote: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const b = buckets.get(d.toDateString()) || { n: 0, promote: 0 }
    days.push({
      label: d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
      short: String(d.getDate()),
      n: b.n,
      promote: b.promote,
    })
  }
  const max = Math.max(1, ...days.map((d) => d.n))

  const groupRows = st.groups.slice(0, 5).map(
    (g) => `<div class="row">
      <span class="dot ${g.kind === "manual" ? "primary" : ""}"></span>
      <div class="grow"><div class="title truncate">${esc(g.name)}</div><div class="sub mono">${esc(g.id)}</div></div>
      <span class="tag">${g.n}</span>
    </div>`
  ).join("")

  const events = (ev.rows || []).slice(0, 6).map(
    (e: any) => `<div class="row">
      <span class="dot ${e.action === "conflict" ? "bad" : e.action === "promote" ? "ok" : e.action === "backup" ? "warn" : ""}"></span>
      <div class="grow"><div class="title">${esc(actionLabel(e.action))}</div><div class="sub">${esc(groupName(e.group_id || "-"))}</div></div>
      <span class="sub">${fmtTime(e.created_at)}</span>
    </div>`
  ).join("")

  main.innerHTML = `
    <div class="hero">
      <div class="hero-main">
        <div class="hero-label">长期记忆</div>
        <div class="hero-value">${s.promoted}<span class="hero-unit">条已生效</span></div>
        <div class="meta">共 ${s.memories} 条 · ${s.drafts + s.conflicted} 条待处理</div>
      </div>
      <div class="hero-ring" style="--pct:${ratio}">
        <span>${ratio}%</span>
      </div>
    </div>

    <div class="card metrics">
      <div><span>草稿</span><b>${s.drafts}</b></div>
      <div><span>冲突</span><b>${s.conflicted}</b></div>
      <div><span>归档</span><b>${s.archived}</b></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>近 14 天事件</h3><div class="spacer"></div><span class="aside">共 ${days.reduce((n, d) => n + d.n, 0)} 次</span></div>
      <div class="chart">
        ${days.map((d) => `<div class="chart-col" title="${d.label}：${d.n} 次事件">
          <i class="${d.n ? "" : "zero"}" style="height:${d.n ? Math.max(4, Math.round((d.n / max) * 100)) : 3}%"></i>
          <span>${d.short}</span>
        </div>`).join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>存储</h3><div class="spacer"></div><span class="aside">${bytes(st.size)} / ${st.budget.softMb} MB · ${pctLabel}%</span></div>
      <div class="bar ${barClass}"><i style="width:max(${pct}%, 2px)"></i></div>
      <div class="row" style="margin-top:8px">
        <button class="btn sm" id="maintain">${icon("refresh", 12)} 立即维护</button>
        <button class="btn sm" id="backup">${icon("folder", 12)} 备份</button>
        <span class="hint">硬预算 ${st.budget.hardMb} MB</span>
      </div>
      <div class="meta" style="margin-top:7px">SQLite ${esc(st.driver)} · 超过硬预算只停写，读取不受影响</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>自动捕获</h3><div class="spacer"></div><span class="dot ${alive ? "ok" : "bad"}"></span></div>
      <div class="meta">${alive ? "插件在线" : "插件离线"}${age !== null ? ` · 心跳 ${Math.round(age / 1000)} 秒前` : ""}</div>
      <div class="meta">${st.capture?.enabled === false ? "已关闭" : "会话空闲 8 秒后提炼"}${st.capture?.modelID ? ` · ${esc(st.capture.modelID)}` : ""}</div>
      <div class="meta">上次空闲 ${hb?.lastIdleAt ? fmtTime(hb.lastIdleAt) : "从未"} · 上次捕获 ${hb?.lastCaptureAt ? fmtTime(hb.lastCaptureAt) : "从未"}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>记忆组</h3><div class="spacer"></div><span class="aside">${st.groups.length}</span></div>
      ${groupRows || `<div class="hint">还没有组</div>`}
    </div>

    <div class="card">
      <div class="card-head"><h3>最近事件</h3></div>
      ${events || `<div class="hint">暂无</div>`}
    </div>`

  document.getElementById("maintain")?.addEventListener("click", async () => {
    try {
      const r = await api("/maintain", "POST")
      toast(`维护完成：清理 ${r.expiredDrafts ?? 0} 条草稿，归档 ${r.archived ?? 0} 条`)
      void renderOverview()
    } catch (err) { toast((err as Error).message, "error") }
  })
  document.getElementById("backup")?.addEventListener("click", async () => {
    try {
      const r = await api("/backup", "POST")
      toast(`已备份 ${bytes(r.size)}`)
    } catch (err) { toast((err as Error).message, "error") }
  })
}

function highlight(text: string, q: string) {
  if (!q) return esc(text)
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  let out = ""
  while (true) {
    const j = lower.indexOf(ql, i)
    if (j < 0) { out += esc(text.slice(i)); break }
    out += esc(text.slice(i, j)) + "<mark>" + esc(text.slice(j, j + q.length)) + "</mark>"
    i = j + q.length
  }
  return out
}

function groupName(id: string) {
  return S.status?.groups.find((g) => g.id === id)?.name || id
}

function itemCard(r: Row, actions: string, q = "") {
  return `<div class="item" data-open="${esc(r.id)}" role="button" tabindex="0">
    <div class="content">${highlight(r.content, q)}</div>
    <div class="foot">
      ${tag(STATUS[r.status]?.label || r.status, STATUS[r.status]?.tone || "")}
      <span class="kind">${esc(KIND[r.kind] || r.kind)}</span>
      ${r.kind === "progress" || r.kind === "summary"
        ? `<span class="meta">确认 ${fmtAgo(r.last_seen_at || r.updated_at)}</span>${Date.now() - (r.last_seen_at || r.updated_at) > 14 * 86_400_000 ? tag("未复核", "warning") : ""}`
        : ""}
      <span class="group">${esc(groupName(r.group_id))}</span>
      ${r.pinned ? `<span class="pin" title="置顶">${icon("star", 10)}</span>` : ""}
      <span class="spacer"></span>
      ${actions}
    </div>
  </div>`
}

async function renderList(status: "draft" | "promoted" | "conflicted") {
  const data = await api(`/list?status=${status}&limit=100`)
  S.rows = data.rows || []
  if (!S.rows.length) {
    main.innerHTML = empty(status === "draft" ? "没有待处理的草稿。会话空闲时会自动捕获。" : "这里还没有记忆", "inbox")
    return
  }
  main.innerHTML = `<div class="list">${S.rows
    .map((r) =>
      itemCard(
        r,
        status === "draft"
          ? `<button class="btn sm accent" data-act="promote" data-id="${esc(r.id)}">晋升</button>
             <button class="btn sm ghost" data-act="forget" data-id="${esc(r.id)}">丢弃</button>`
          : `<button class="btn sm ghost" data-act="forget" data-id="${esc(r.id)}">遗忘</button>`
      )
    )
    .join("")}</div>
    <div class="list-hint">${icon("inbox", 12)} 草稿来自会话空闲时的自动捕获；晋升后才会进入下一轮会话的上下文。</div>`
}

async function renderMemories() {
  const qs = new URLSearchParams({ limit: "30", offset: String(S.offset) })
  if (S.filters.status) qs.set("status", S.filters.status)
  if (S.filters.group) qs.set("group", S.filters.group)
  if (S.filters.kind) qs.set("kind", S.filters.kind)
  if (S.filters.sort) qs.set("sort", S.filters.sort)
  if (S.filters.q) qs.set("q", S.filters.q)
  const data = await api(`/list?${qs.toString()}`)
  const st = S.status || (await loadStatus())
  S.rows = S.offset === 0 ? data.rows || [] : [...S.rows, ...(data.rows || [])]
  S.total = data.total ?? S.rows.length

  const groupOpts = [`<option value="">全部组</option>`]
    .concat(st.groups.map((g) => `<option value="${esc(g.id)}" ${S.filters.group === g.id ? "selected" : ""}>${esc(g.name)}</option>`))
    .join("")
  const statusOpts = ["", "promoted", "draft", "conflicted", "archived"]
    .map((x) => `<option value="${x}" ${S.filters.status === x ? "selected" : ""}>${x ? STATUS[x]?.label || x : "全部状态"}</option>`)
    .join("")
  const kindOpts = ["", "decision", "pitfall", "progress", "summary", "reference", "preference", "procedure"]
    .map((x) => `<option value="${x}" ${S.filters.kind === x ? "selected" : ""}>${x ? KIND[x] : "全部类型"}</option>`)
    .join("")
  const sortOpts = [["updated", "最近更新"], ["confidence", "置信度"], ["hits", "命中次数"], ["created", "创建时间"]]
    .map(([v, l]) => `<option value="${v}" ${S.filters.sort === v ? "selected" : ""}>${l}</option>`)
    .join("")

  main.innerHTML = `
    <div class="filters">
      <input class="field grow" id="q" placeholder="搜索记忆…" aria-label="搜索记忆" value="${esc(S.filters.q)}">
      <select class="field" id="fgroup" aria-label="按组筛选">${groupOpts}</select>
    </div>
    <div class="filters">
      <select class="field" id="fstatus" aria-label="按状态筛选">${statusOpts}</select>
      <select class="field" id="fkind" aria-label="按类型筛选">${kindOpts}</select>
      <select class="field" id="fsort" aria-label="排序方式">${sortOpts}</select>
    </div>
    <div class="row" style="margin:2px 2px 0">
      <span class="hint">共 ${S.total} 条 · 已显示 ${S.rows.length}</span>
      <div class="spacer" style="flex:1"></div>
      ${S.filters.q || S.filters.group || S.filters.status || S.filters.kind ? `<button class="btn sm ghost" id="clear">清除筛选</button>` : ""}
    </div>
    <div class="list">
      ${S.rows.map((r) => itemCard(r, `<span class="meta">命中 ${r.hits}</span>`, S.filters.q)).join("") || empty("没有匹配的记忆")}
    </div>
    ${S.rows.length < S.total ? `<button class="btn" id="more">加载更多 (${S.rows.length}/${S.total})</button>` : ""}`

  const q = document.getElementById("q") as HTMLInputElement
  let timer: any
  q.addEventListener("input", () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      S.filters.q = q.value.trim()
      S.offset = 0
      void renderMemories()
    }, 280)
  })
  const bind = (id: string, key: "group" | "status" | "kind" | "sort") => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      S.filters[key] = (e.target as HTMLSelectElement).value
      S.offset = 0
      void renderMemories()
    })
  }
  bind("fgroup", "group")
  bind("fstatus", "status")
  bind("fkind", "kind")
  bind("fsort", "sort")
  document.getElementById("clear")?.addEventListener("click", () => {
    S.filters = { q: "", group: "", status: "", kind: "", sort: "updated" }
    S.offset = 0
    void renderMemories()
  })
  document.getElementById("more")?.addEventListener("click", () => {
    S.offset += 30
    void renderMemories()
  })
}

async function renderState() {
  const st = S.status || (await loadStatus())
  if (!st.groups.length) {
    main.innerHTML = empty("还没有记忆组", "folder")
    return
  }
  if (!S.stateGroup || !st.groups.some((g) => g.id === S.stateGroup)) S.stateGroup = st.groups[0].id
  const data = await api("/state?group=" + encodeURIComponent(S.stateGroup))
  const rows: any[] = data.rows || []
  const scopes: any[] = data.sessionScopes || []

  const sessionTitles = new Map<string, string>()
  try {
    const projects = (await host.listProjects()).projects || []
    const snaps = await Promise.all(projects.map((p) => host.listSessions(p.id).catch(() => ({ sessions: [] }))))
    for (const x of snaps.flatMap((snap) => snap.sessions || [])) {
      if (!sessionTitles.has(x.id)) sessionTitles.set(x.id, x.title || "")
    }
  } catch {}
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const labels: Record<string, string> = { status: "状态", next: "下一步", blocker: "阻塞" }
  const keys = ["status", "next", "blocker"]
  const groupOpts = st.groups
    .map((g) => `<option value="${esc(g.id)}" ${S.stateGroup === g.id ? "selected" : ""}>${esc(g.name)}</option>`)
    .join("")
  const custom = rows.filter((r) => !keys.includes(r.key))

  main.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>当前状态</h3><div class="spacer"></div><span class="aside">覆盖写，不追加</span></div>
      <div class="meta" style="margin-bottom:8px">这里编辑组级状态（所有会话共享）。会话摘要的 next_steps 只写进所属会话，见下方“会话级状态”。</div>
      <select class="field" id="stgroup" aria-label="选择组">${groupOpts}</select>
      <form id="state-form" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        ${keys
          .map((k) => {
            const r = byKey.get(k)
            const inj = r?.last_injected_at ? ` · 注入 ${fmtAgo(r.last_injected_at)}` : ""
            return `<label class="field-wrap"><span class="meta">${labels[k]}${r ? ` · 更新 ${fmtAgo(r.updated_at)}${inj}` : " · 未设置"}</span>
              <textarea class="field" name="${k}" rows="2" placeholder="${k === "blocker" ? "没有就留空" : ""}">${esc(r?.value || "")}</textarea></label>`
          })
          .join("")}
        <div class="row"><button class="btn sm primary" type="submit">保存状态</button>
        <span class="hint">清空文本框即删除该项</span></div>
      </form>
      ${custom.length ? `<div class="meta" style="margin-top:8px">其他键：${custom.map((r) => `${esc(r.key)}=${esc(r.value)}`).join(" · ")}</div>` : ""}
    </div>
    ${scopes.length ? `<div class="card">
      <div class="card-head"><h3>会话级状态</h3><div class="spacer"></div><span class="aside">${scopes.length} 个会话</span></div>
      <div class="hint" style="margin-bottom:6px">摘要自动写入，只影响该会话；不进入组级状态。</div>
      ${scopes.map((s2) => `<div class="session-scope">
        <div class="scope-head">
          <span class="tag" title="${esc(s2.session_id)}">${esc(sessionTitles.get(s2.session_id) || String(s2.session_id).slice(0, 10))}</span>
          <span class="meta">${fmtAgo(s2.updated_at)}${s2.last_injected_at ? ` · 注入 ${fmtAgo(s2.last_injected_at)}` : ""}</span>
          <button class="btn sm ghost" data-clear-scope="${esc(s2.session_id)}" type="button">清除</button>
        </div>
        <div class="scope-rows">
          ${s2.rows.map((r: any) => `<div><span class="meta">${labels[r.key] || r.key}</span> ${esc(r.value)}</div>`).join("")}
        </div>
      </div>`).join("")}
    </div>` : ""}
    <div class="hint">状态只影响注入的首段；不会改写或删除任何历史记忆。</div>`

  document.getElementById("stgroup")?.addEventListener("change", (e) => {
    S.stateGroup = (e.target as HTMLSelectElement).value
    void renderState()
  })
  main.querySelectorAll("[data-clear-scope]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const sid = (btn as HTMLElement).dataset.clearScope || ""
      const scope = scopes.find((x) => x.session_id === sid)
      if (!scope) return
      try {
        for (const r of scope.rows) {
          await api("/state-clear", "POST", { group: S.stateGroup, key: r.key, session: sid })
        }
        toast("已清除该会话的状态")
        void renderState()
      } catch (err) {
        toast((err as Error).message, "error")
      }
    })
  )
  document.getElementById("state-form")?.addEventListener("submit", async (e) => {
    e.preventDefault()
    const f = e.target as HTMLFormElement
    try {
      for (const key of keys) {
        const value = (f.elements.namedItem(key) as HTMLTextAreaElement).value
        await api("/state-set", "POST", { group: S.stateGroup, key, value })
      }
      toast("状态已保存")
      void renderState()
    } catch (err) {
      toast((err as Error).message, "error")
    }
  })
}

async function renderConflicts() {
  const data = await api("/conflicts")
  S.pairs = data.pairs || []
  if (!S.pairs.length) {
    main.innerHTML = empty("没有待裁决的冲突。相似的新记忆会自动进入这里。", "alert")
    return
  }
  main.innerHTML = `<div class="hint" style="margin-bottom:2px">选一边保留，另一边归档；裁决前两条都不会注入。</div>` +
    S.pairs
      .map(
        (p: any, i: number) => `<div class="card">
          <div class="content" style="margin-bottom:6px">${esc(p.a.content)}</div>
          <div class="foot" style="display:flex;gap:6px;margin-bottom:8px">
            ${tag(STATUS[p.a.status]?.label || p.a.status, STATUS[p.a.status]?.tone || "")}
            <span class="mono meta">${esc(p.a.id)}</span>
          </div>
          <div class="row">
            <button class="btn sm primary" data-resolve="${i}" data-keep="a">保留上面</button>
            <button class="btn sm" data-resolve="${i}" data-keep="b">保留下面</button>
          </div>
          <hr style="border:0;border-top:1px dashed var(--oc-border);margin:9px 0">
          <div class="content" style="margin-bottom:6px">${esc(p.b.content)}</div>
          <div class="foot" style="display:flex;gap:6px">
            ${tag(STATUS[p.b.status]?.label || p.b.status, STATUS[p.b.status]?.tone || "")}
            <span class="mono meta">${esc(p.b.id)}</span>
          </div>
        </div>`
      )
      .join("")
}

const PRED_LABEL: Record<string, string> = {
  belongs_to: "属于", about: "关于", from_session: "来自会话", mentions: "提及",
  in_file: "位于", similar: "相似", supersedes: "取代", derived_from: "提炼自",
}
const predLabel = (p: string) => PRED_LABEL[p] || p

const TYPE_LABEL: Record<string, string> = {
  memory: "记忆", group: "组", topic: "主题", session: "会话", file: "文件",
}

async function renderGraph() {
  const st = S.status || (await loadStatus())
  const groupOpts = [`<option value="">全部组</option>`]
    .concat(st.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`))
    .join("")
  const layoutOpts = [["cose", "力导向"], ["concentric", "同心"], ["grid", "网格"]]
    .map(([v, l]) => `<option value="${v}" ${S.graphLayout === v ? "selected" : ""}>${l}</option>`)
    .join("")

  main.innerHTML = `
    <div class="card graph-card" id="graph-card">
      <div class="graph-head">
        <select class="field" id="ggroup" aria-label="按组过滤">${groupOpts}</select>
        <select class="field" id="glayout" aria-label="布局">${layoutOpts}</select>
        <button class="btn sm icon" id="gfull" title="全屏" aria-label="全屏">${icon("expand", 13)}</button>
      </div>
      <div class="graph-tools">
        <input class="field" id="gsearch" placeholder="搜索节点…" aria-label="搜索节点" value="${esc(S.graphSearch)}">
        <button class="btn icon" id="gzoomout" title="缩小" aria-label="缩小">−</button>
        <button class="btn icon" id="gfit" title="适应画布" aria-label="适应画布">${icon("fit", 12)}</button>
        <button class="btn icon" id="gzoomin" title="放大" aria-label="放大">+</button>
        <button class="btn icon" id="gforce" title="引力 / 斥力" aria-label="引力与斥力">${icon("tune", 12)}</button>
        <button class="btn icon" id="gexport" title="导出 PNG" aria-label="导出 PNG">${icon("download", 12)}</button>
      </div>
      <div class="graph-wrap">
        <div class="graph-canvas" id="cy"><div class="loading"><div class="spinner"></div></div></div>
        <div class="force-pop" id="gforce-pop" hidden>
          <div class="force-head"><span>力与显示</span><span>实时</span></div>
          <label class="force-row force-only"><span>中心力</span><input type="range" id="fcenter" min="0" max="100" value="${S.forces.center}"><b id="fcenter-v">${S.forces.center}</b></label>
          <label class="force-row force-only"><span>斥力</span><input type="range" id="frepel" min="0" max="100" value="${S.forces.repel}"><b id="frepel-v">${S.forces.repel}</b></label>
          <label class="force-row force-only"><span>链接力</span><input type="range" id="flink" min="0" max="100" value="${S.forces.link}"><b id="flink-v">${S.forces.link}</b></label>
          <label class="force-row force-only"><span>边长</span><input type="range" id="fdistance" min="20" max="200" value="${S.forces.distance}"><b id="fdistance-v">${S.forces.distance}</b></label>
          <label class="force-row"><span>标签</span><input type="range" id="flabels" min="0" max="100" value="${S.forces.labels}"><b id="flabels-v">${S.forces.labels}</b></label>
          <button class="btn sm ghost" id="freset">重置为默认</button>
        </div>
      </div>
      <div class="graph-sel" id="ginfo" hidden>
        <span id="gi-type" class="tag"></span>
        <strong id="gi-label"></strong>
        <span id="gi-meta" class="meta"></span>
        <button class="btn sm accent" id="gi-act"></button>
        <button class="btn icon ghost" id="gi-close" aria-label="关闭">${icon("close", 12)}</button>
      </div>
      <div class="graph-legend" id="glegend"></div>
      <div class="graph-foot">
        <span id="ghint">加载中…</span>
        <button class="btn sm ghost" id="greset" hidden>返回全图</button>
      </div>
    </div>`

  const canvas = document.getElementById("cy")!
  const info = document.getElementById("ginfo") as HTMLElement

  const fpop = document.getElementById("gforce-pop") as HTMLElement | null
  const forceInput = (id: string) => document.getElementById(id) as HTMLInputElement | null
  const fcenter = forceInput("fcenter")
  const frepel = forceInput("frepel")
  const flink = forceInput("flink")
  const fdistance = forceInput("fdistance")
  const flabels = forceInput("flabels")
  const forcePairs: [HTMLInputElement | null, "center" | "repel" | "link" | "distance" | "labels"][] = [
    [fcenter, "center"],
    [frepel, "repel"],
    [flink, "link"],
    [fdistance, "distance"],
    [flabels, "labels"],
  ]
  const syncForceEnabled = () => {
    const on = S.graphLayout === "cose"
    for (const el of [fcenter, frepel, flink, fdistance]) if (el) el.disabled = !on
    if (fpop) fpop.classList.toggle("off", !on)
  }
  const syncForceInputs = () => {
    for (const [el, key] of forcePairs) {
      if (el) el.value = String(S.forces[key])
      const b = el ? document.getElementById(`${el.id}-v`) : null
      if (b) b.textContent = String(S.forces[key])
    }
  }
  const saveForces = () => {
    try { localStorage.setItem("am.forces", JSON.stringify(S.forces)) } catch {}
  }
  const reheat = () => {
    if (S.graphLayout !== "cose") return
    if (S.sim) {
      applySimForces()
      S.sim.alpha(0.6).restart()
    } else {
      startSim(0.4)
    }
  }
  let forceTimer: any = 0
  const queueReheat = () => {
    clearTimeout(forceTimer)
    forceTimer = setTimeout(reheat, 160)
  }
  document.getElementById("gforce")?.addEventListener("click", (e) => {
    e.stopPropagation()
    if (fpop) fpop.hidden = !fpop.hidden
  })
  for (const [el, key] of forcePairs) {
    el?.addEventListener("input", () => {
      S.forces[key] = Number(el.value)
      syncForceInputs()
      saveForces()
      if (key === "labels") syncLabels()
      else queueReheat()
    })
  }
  document.getElementById("freset")?.addEventListener("click", () => {
    S.forces = { center: 90, repel: 25, link: 90, distance: 35, labels: 45 }
    syncForceInputs()
    saveForces()
    syncLabels()
    queueReheat()
  })
  syncForceInputs()
  syncForceEnabled()

  let resizeTimer: any = 0
  let fitW = 0
  let fitH = 0
  if (S.graphRO) S.graphRO.disconnect()
  if (typeof ResizeObserver !== "undefined") {
    S.graphRO = new ResizeObserver(() => {
      if (S.view !== "graph" || !S.graph) return
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      S.graph.resize() // 同步绘制缓冲，不移动节点
      if (Math.abs(w - fitW) < 40 && Math.abs(h - fitH) < 40) return
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (S.graph) fitCapped()
      }, 320)
    })
    S.graphRO.observe(canvas)
  }

  const palette: Record<string, string> = {}
  const readPalette = () => {
    const css = getComputedStyle(document.documentElement)
    const col = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
    palette.memory = col("--oc-primary-text", col("--oc-primary", "#3b5bdb"))
    palette.group = col("--oc-warning-text", col("--oc-warning", "#e8890c"))
    palette.topic = col("--oc-muted", "#6b7280")
    palette.session = col("--oc-muted", "#5f6b7a")
    palette.file = col("--oc-error", "#e03131")
    palette.muted = col("--oc-muted", "#6b7280")
    palette.fg = col("--oc-fg", "#17181a")
    palette.bg = col("--oc-bg", "#ffffff")
    palette.border = col("--oc-border", "#e6e7ea")
  }

  const visibleCount = () =>
    S.graph ? S.graph.nodes().filter((n: any) => n.style("display") !== "none").length : 0

  const legendHtml = () => {
    const counts: Record<string, number> = {}
    for (const n of S.graphData?.nodes || []) counts[n.type] = (counts[n.type] || 0) + 1
    return Object.keys(TYPE_LABEL)
      .filter((t) => counts[t])
      .map(
        (t) => `<button class="legend-chip" data-type="${t}" aria-pressed="${S.graphTypes.has(t)}">
          <i style="background:${palette[t] || palette.muted}"></i>${TYPE_LABEL[t]}<span>${counts[t]}</span>
        </button>`
      )
      .join("")
  }

  const bindLegend = () => {
    document.querySelectorAll(".legend-chip").forEach((el) =>
      el.addEventListener("click", () => {
        const type = (el as HTMLElement).dataset.type!
        if (S.graphTypes.has(type)) {
          if (S.graphTypes.size === 1) return
          S.graphTypes.delete(type)
        } else S.graphTypes.add(type)
        applyVisibility()
      })
    )
  }

  // 标签：先按缩放阈值筛，再做屏幕空间避让 + 数量上限。
  // 只看缩放的话，滑杆拉满会把几百个标签堆成一堵墙。
  let labelRaf = 0
  const applyLabels = () => {
    const cy = S.graph
    if (!cy) return
    const z = cy.zoom()
    const total = cy.nodes().length
    const threshold = 1.9 - (Math.max(0, Math.min(100, S.forces.labels)) / 100) * 1.55
    const groups: any[] = []
    const mems: any[] = []
    cy.nodes().forEach((n: any) => {
      if (n.style("display") === "none") return
      const type = n.data("type")
      if (type === "group") {
        groups.push(n)
        return
      }
      const anchor = type === "memory"
      const hide =
        z < 0.55 ||
        (total > 8 && (anchor ? z < Math.max(0.55, threshold - 0.3) : z < threshold))
      if (!hide) mems.push(n)
    })
    const degree = (n: any) => (typeof n.degree === "function" ? n.degree() : 0)
    mems.sort((a: any, b: any) => {
      const sa = (a.hasClass("sel") ? 1e6 : 0) + (a.hasClass("hl") ? 1e5 : 0) + (a.data("pinned") ? 1e4 : 0) + degree(a)
      const sb = (b.hasClass("sel") ? 1e6 : 0) + (b.hasClass("hl") ? 1e5 : 0) + (b.data("pinned") ? 1e4 : 0) + degree(b)
      return sb - sa
    })
    const cap = z < 0.7 ? 8 : z < 0.95 ? 14 : z < 1.3 ? 22 : 40
    const size = 9.5
    const boxes: any[] = []
    const shown = new Set<string>()
    const rectOf = (n: any) => {
      const p = n.renderedPosition()
      const label = String(n.data("label") || "")
      let w = 0
      for (const ch of label) w += /[㐀-鿿]/.test(ch) ? size : size * 0.58
      w = Math.min(180, Math.max(16, w))
      const y = p.y + Math.max(4, n.renderedHeight() / 2) + 3
      return { x1: p.x - w / 2 - 4, x2: p.x + w / 2 + 4, y1: y - 3, y2: y + size * 1.7 }
    }
    const overlaps = (a: any, b: any) =>
      a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1
    for (const n of groups) {
      boxes.push(rectOf(n))
      shown.add(n.id())
    }
    let count = 0
    for (const n of mems) {
      if (count >= cap) break
      const r = rectOf(n)
      if (boxes.some((b) => overlaps(r, b))) continue
      boxes.push(r)
      shown.add(n.id())
      count++
    }
    cy.nodes().forEach((n: any) => n.toggleClass("far", !shown.has(n.id())))
  }
  const syncLabels = () => {
    if (labelRaf) return
    labelRaf = requestAnimationFrame(() => {
      labelRaf = 0
      applyLabels()
    })
  }

  // 把布局坐标缩放到当前画布并居中；节点大小与字号保持 1x
  // 视口适配：只缩放视图，不搬动节点；小图限制放大倍率
  const fitCapped = () => {
    const cyv = S.graph
    if (!cyv) return
    const bb = cyv.elements().boundingBox({ includeLabels: false })
    if (!(bb.w > 1) || !(bb.h > 1)) return
    const pad = 30
    const zoom = Math.max(
      0.05,
      Math.min((cyv.width() - pad * 2) / bb.w, (cyv.height() - pad * 2) / bb.h, 1.25)
    )
    const cx = (bb.x1 + bb.x2) / 2
    const cyy = (bb.y1 + bb.y2) / 2
    cyv.viewport({
      zoom,
      pan: { x: cyv.width() / 2 - cx * zoom, y: cyv.height() / 2 - cyy * zoom },
    })
    fitW = cyv.width()
    fitH = cyv.height()
    syncLabels()
  }

  const applySimForces = () => {
    const sim = S.sim
    if (!sim) return
    const f = S.forces
    const link = sim.force("link") as any
    if (link) {
      link.distance((l: any) => (l.predicate === "belongs_to" ? f.distance * 2.2 : f.distance))
      const k = 0.15 + (f.link / 100) * 0.85
      link.strength((l: any) => {
        const da = l.source?.deg || 1
        const db = l.target?.deg || 1
        const base = k / Math.max(1, Math.min(da, db))
        return l.predicate === "belongs_to" ? base * 0.3 : base
      })
    }
    const charge = sim.force("charge") as any
    if (charge) charge.strength(-(20 + (f.repel * f.repel) / 20))
    const center = 0.02 + (f.center / 100) * 0.12
    const fx = sim.force("x") as any
    if (fx) fx.strength(center)
    const fy = sim.force("y") as any
    if (fy) fy.strength(center)
  }

  const stopSim = () => {
    if (S.sim) {
      S.sim.stop()
      S.sim = null
    }
    S.simNodes.clear()
  }

  const startSim = (alpha = 0.35, settle = 0, doFit = true, fitOnEnd = false, reset = false) => {
    const cyv = S.graph
    if (!cyv || !S.graphData) return
    S.layoutJob?.stop?.()
    S.layoutJob = null
    stopSim()
    const visible = new Set(
      cyv.nodes().filter((n: any) => n.style("display") !== "none").map((n: any) => n.id())
    )
    const nodes: any[] = []
    const map = S.simNodes
    for (const n of S.graphData.nodes || []) {
      if (!visible.has(n.id)) continue
      const el = cyv.getElementById(n.id)
      if (!el || el.empty()) continue
      const p = el.position()
      const size = Number(el.data("size")) || 10
      const obj = { id: n.id, x: p.x, y: p.y, r: size / 2 + 1, deg: 1 }
      nodes.push(obj)
      map.set(n.id, obj)
    }
    if (!nodes.length) return
    if (reset) {
      const R = Math.max(80, Math.sqrt(nodes.length) * 26)
      nodes.forEach((d: any, i: number) => {
        const a = i * 2.399963 + seedHash(d.id) * 0.9
        const r = R * Math.sqrt((i + 0.5) / nodes.length) * (0.7 + seedHash(d.id + "r") * 0.55)
        d.x = Math.cos(a) * r
        d.y = Math.sin(a) * r
        d.vx = 0
        d.vy = 0
      })
    }
    const links = (S.graphData.edges || [])
      .filter((e: any) => e.src && e.dst && visible.has(e.src) && visible.has(e.dst))
      .map((e: any) => ({ source: e.src, target: e.dst, predicate: e.predicate || "" }))

    // 邻接数：度数大的枢纽连线更“软”，让社区自然成形（d3 默认的 1/min(deg) 思路）
    const byId = new Map(nodes.map((d: any) => [d.id, d]))
    for (const l of links as any[]) {
      const a = byId.get(l.source)
      const b = byId.get(l.target)
      if (a) a.deg = (a.deg || 0) + 1
      if (b) b.deg = (b.deg || 0) + 1
    }
    const linkK = () => 0.15 + (S.forces.link / 100) * 0.85
    const linkStrength = (k: number) => (l: any) => {
      const da = l.source?.deg || 1
      const db = l.target?.deg || 1
      const base = k / Math.max(1, Math.min(da, db))
      return l.predicate === "belongs_to" ? base * 0.3 : base
    }
    const linkDistance = (d: number) => (l: any) => (l.predicate === "belongs_to" ? d * 2.2 : d)

    const sim = forceSimulation(nodes)
      .force("link", forceLink(links).id((d: any) => d.id).distance(linkDistance(S.forces.distance)).strength(linkStrength(linkK())))
      .force("charge", forceManyBody().strength(-(20 + (S.forces.repel * S.forces.repel) / 20)).distanceMax(600))
      .force("collide", forceCollide((d: any) => d.r + 1).strength(0.7).iterations(1))
      .force("x", forceX(0).strength(0.02 + (S.forces.center / 100) * 0.12))
      .force("y", forceY(0).strength(0.02 + (S.forces.center / 100) * 0.12))
      .alphaDecay(0.035)
      .velocityDecay(0.3)
      .stop()

    // 先静跑若干步再显示，避免打开时从大圆飞入；之后留一点 alpha 让它轻轻落位
    const warm = settle || (nodes.length > 250 ? 190 : nodes.length > 80 ? 90 : 50)
    for (let i = 0; i < warm; i++) sim.tick()
    cyv.batch(() => {
      for (const d of nodes) {
        const el = cyv.getElementById(d.id)
        if (el && !el.empty()) el.position({ x: d.x, y: d.y })
      }
    })
    if (doFit) fitCapped()

    sim.on("tick", () => {
      if (S.sim !== sim) return
      cyv.batch(() => {
        for (const d of nodes) {
          const el = cyv.getElementById(d.id)
          if (el && !el.empty()) el.position({ x: d.x, y: d.y })
        }
      })
    })
    sim.on("end", () => {
      if (S.sim === sim && fitOnEnd) fitCapped()
    })
    S.sim = sim
    if (alpha > 0) sim.alpha(alpha).restart()
  }

  // 同心：按类型分层铺环（组 → 会话 → 记忆 → 主题），比 Cytoscape 自带同心可读
  const runRadialLayout = (cyv: any) => {
    const order: Record<string, number> = { group: 0, session: 1, memory: 2, topic: 3 }
    const rings: any[][] = [[], [], [], []]
    cyv.nodes().forEach((n: any) => {
      if (n.style("display") === "none") return
      rings[order[n.data("type")] ?? 2].push(n)
    })
    const R = Math.max(200, Math.sqrt(cyv.nodes().length) * 30)
    const radii = [R * 0.16, R * 0.45, R * 0.74, R]
    const offset = Math.PI * 2 * seedHash("radial")
    cyv.batch(() => {
      rings.forEach((list, i) => {
        const r = radii[i]
        list.forEach((n, k) => {
          const a = offset + (Math.PI * 2 * k) / Math.max(1, list.length)
          n.position({ x: Math.cos(a) * r, y: Math.sin(a) * r })
        })
      })
    })
    if (S.graph === cyv) fitCapped()
  }

  const runStaticLayout = () => {
    const cyv = S.graph
    if (!cyv) return
    S.layoutJob?.stop?.()
    if (S.graphLayout === "concentric") {
      runRadialLayout(cyv)
      return
    }
    const opts: any = { name: S.graphLayout, animate: false, fit: false, padding: 30 }
    if (S.graphLayout === "grid") Object.assign(opts, { avoidOverlap: true, spacingFactor: 1.15 })
    const job = cyv.layout(opts)
    S.layoutJob = job
    job.one("layoutstop", () => {
      S.layoutJob = null
      if (S.graph === cyv) fitCapped()
    })
    job.run()
    // 个别布局（如同心）在大图上不派发 layoutstop，补一次兜底适配
    requestAnimationFrame(() => {
      if (S.graph === cyv && S.layoutJob === job) fitCapped()
    })
  }

  const runLayout = () => {
    if (S.graphLayout !== "cose") {
      S.layoutJob?.stop?.()
      S.layoutJob = null
    }
    if (S.graphLayout === "cose") {
      if (S.sim) {
        // 只改力，不重建：节点滑过去，而不是瞬移
        applySimForces()
        S.sim.alpha(0.6).restart()
      } else {
        startSim(0.35, 0, true, true, true)
      }
      return
    }
    stopSim()
    runStaticLayout()
  }

  const updateHint = () => {
    const hint = document.getElementById("ghint")
    if (hint) {
      const q = S.graphSearch.trim().toLowerCase()
      if (q) {
        const hits = S.graph
          ? S.graph.nodes().filter((n: any) => !n.hasClass("dim") && n.style("display") !== "none").length
          : 0
        hint.textContent = hits ? `${hits} 个匹配 · Enter 定位` : `没有匹配「${S.graphSearch}」的节点`
      } else {
        const parts = [`${visibleCount()} 个节点`, "单击查看"]
        if (S.graphFocus) parts.push("邻居视图")
        else if ((S.graph?.nodes().length || 0) > 120) parts.push("可点图例精简")
        hint.textContent = parts.join(" · ")
      }
    }
    const reset = document.getElementById("greset") as HTMLButtonElement | null
    if (reset) reset.hidden = !S.graphFocus
  }

  const applyVisibility = (initial = false, doLayout = true) => {
    const cy = S.graph
    if (!cy) return
    const focus = S.graphFocus ? cy.getElementById(S.graphFocus) : null
    cy.batch(() => {
      cy.nodes().forEach((n: any) => {
        const typeOk = S.graphTypes.has(n.data("type"))
        const focusOk = !focus || focus.empty() || n.closedNeighborhood().contains(focus)
        n.style("display", typeOk && focusOk ? "element" : "none")
      })
      cy.edges().forEach((e: any) => {
        const vis = e.source().style("display") !== "none" && e.target().style("display") !== "none"
        e.style("display", vis ? "element" : "none")
      })
    })
    if (doLayout) {
      if (S.graphLayout === "cose") {
        if (initial) startSim(0, 120, true, false)
        else startSim(0.2, 15, false, false)
      } else runLayout()
    }
    const legend = document.getElementById("glegend")
    if (legend) legend.innerHTML = legendHtml()
    bindLegend()
    updateHint()
  }

  let selNode: any = null
  const select = (n: any | null) => {
    if (selNode && selNode.inside() && !selNode.removed()) {
      selNode.removeClass("sel")
      selNode.connectedEdges().removeClass("sel")
    }
    selNode = n
    if (n) {
      n.addClass("sel")
      n.connectedEdges().addClass("sel")
    }
  }

  const showInfo = (n: any) => {
    select(n)
    const type = n.data("type")
    document.getElementById("gi-type")!.textContent = TYPE_LABEL[type] || type
    document.getElementById("gi-label")!.textContent = n.data("label")
    const status = n.data("status")
    document.getElementById("gi-meta")!.textContent =
      `${n.degree()} 条关系` + (status ? ` · ${STATUS[status]?.label || status}` : "")
    const act = document.getElementById("gi-act") as HTMLButtonElement
    const focused = S.graphFocus === n.id()
    act.hidden = focused
    act.textContent = type === "memory" ? "打开详情" : type === "group" ? "只看该组" : "只看邻居"
    act.onclick = () => {
      if (type === "memory") void openDetail(n.id().slice("memory:".length))
      else if (type === "group") {
        ;(document.getElementById("ggroup") as HTMLSelectElement).value = n.id().slice("group:".length)
        void load()
      } else {
        S.graphFocus = n.id()
        applyVisibility()
        showInfo(n)
      }
    }
    info.hidden = false
  }

  const draw = () => {
    const data = S.graphData
    if (!data || !data.nodes.length) {
      if (S.graph) {
        S.graph.destroy()
        S.graph = null
      }
      canvas.innerHTML = `<div class="empty">
        ${icon("layers", 24)}
        <div class="empty-title">这个范围还没有节点</div>
        <div class="empty-sub">在该组的项目里产生会话后，记忆、主题和组会自动出现</div>
      </div>`
      const hint = document.getElementById("ghint")
      if (hint) hint.textContent = "暂无节点"
      const legend = document.getElementById("glegend")
      if (legend) legend.innerHTML = ""
      const reset = document.getElementById("greset") as HTMLButtonElement | null
      if (reset) reset.hidden = true
      info.hidden = true
      return
    }
    readPalette()
    const veryDense = data.nodes.length > 60
    const degree = new Map<string, number>()
    for (const e of data.edges || []) {
      degree.set(e.src, (degree.get(e.src) || 0) + 1)
      degree.set(e.dst, (degree.get(e.dst) || 0) + 1)
    }
    const sizeOf = (n: any) => {
      const g = Math.sqrt(degree.get(n.id) || 0)
      switch (n.type) {
        case "memory": return Math.round((10 + Math.min(8, g * 2.2)) * 10) / 10
        case "group": return Math.round((9 + Math.min(5, g * 1.1)) * 10) / 10
        case "topic": return Math.round((4.5 + Math.min(3, g * 0.6)) * 10) / 10
        case "session": return Math.round((5.5 + Math.min(2, g)) * 10) / 10
        default: return 5.5
      }
    }
    stopSim()
    if (S.graph) S.graph.destroy()
    canvas.innerHTML = ""

    S.graph = cytoscape({
      container: canvas,
      minZoom: 0.05,
      maxZoom: 2.4,
      elements: [
        ...data.nodes.map((n: any) => ({
          data: { id: n.id, label: n.label, type: n.type, status: n.status || "", size: sizeOf(n) },
        })),
        ...data.edges.map((e: any) => ({
          data: {
            id: `${e.src}|${e.predicate}|${e.dst}`,
            source: e.src,
            target: e.dst,
            predicate: e.predicate,
            predLabel: predLabel(e.predicate),
          },
        })),
      ],
      style: [
        {
          selector: "node",
          style: {
            label: "data(label)",
            "font-size": 8,
            "font-weight": 400,
            "text-wrap": "ellipsis",
            "text-max-width": 96,
            "text-background-opacity": 0,
            "text-outline-width": 1.5,
            "text-outline-color": palette.bg,
            "text-valign": "bottom",
            "text-margin-y": 4,
            width: "data(size)",
            height: "data(size)",
            "background-opacity": 0.92,
            "border-width": 0,
            "background-color": (ele: any) => palette[ele.data("type")] || palette.muted,
            color: palette.muted,
          } as any,
        },
        { selector: "node[type='memory']", style: { "font-size": 9.5, "font-weight": 600, color: palette.fg } as any },
        { selector: "node[type='group']", style: { "font-size": 9, "font-weight": 600, color: palette.fg } as any },
        {
          selector: "node[type='topic']",
          style: {
            "background-opacity": 0,
            "border-width": 1,
            "border-color": palette.muted,
            "border-opacity": 0.55,
          } as any,
        },
        { selector: "node[type='session']", style: { "background-opacity": 0.8 } as any },
        { selector: "node[status='draft']", style: { "background-opacity": 0.4 } as any },
        { selector: "node[status='conflicted']", style: { "border-width": 2, "border-color": palette.file } as any },
        { selector: "node[status='archived']", style: { opacity: 0.35 } as any },
        {
          selector: "edge",
          style: {
            width: 0.6,
            "line-color": palette.muted,
            "target-arrow-shape": "none",
            "curve-style": "bezier",
            "control-point-step-size": 26,
            opacity: 0.26,
          } as any,
        },
        { selector: "node.far", style: { "text-opacity": 0 } as any },
        { selector: "edge.near", style: { opacity: 0.55, width: 0.95 } as any },
        { selector: "node.hoverdim", style: { opacity: 0.14 } as any },
        { selector: "edge.hoverdim", style: { opacity: 0.04 } as any },
        { selector: "node.hl", style: { opacity: 1, "border-width": 2, "border-color": palette.fg, "text-opacity": 1 } as any },
        {
          selector: "edge.hl",
          style: {
            opacity: 0.5,
            width: 0.9,
            "target-arrow-shape": "triangle",
            "target-arrow-color": palette.muted,
            "arrow-scale": 0.5,
          } as any,
        },
        { selector: "node.sel", style: { "border-width": 2, "border-color": palette.fg, "text-opacity": 1 } as any },
        {
          selector: "edge.sel",
          style: {
            label: veryDense ? "" : "data(predLabel)",
            "font-size": 7,
            color: palette.muted,
            "text-rotation": "autorotate",
            "text-background-color": palette.bg,
            "text-background-opacity": 0.86,
            "text-background-padding": 1,
            "line-color": palette.muted,
            "target-arrow-color": palette.muted,
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.55,
            width: 1.2,
            opacity: 0.9,
          } as any,
        },
        { selector: "node.dim", style: { opacity: 0.12 } as any },
        { selector: "edge.dim", style: { opacity: 0.035, "text-opacity": 0 } as any },
      ],
      layout: { name: "preset", animate: false } as any,
    })

    S.graph.on("zoom", syncLabels)
    syncLabels()

    S.graph.on("mouseover", "node", (evt: any) => {
      if (S.graphSearch) return
      const n = evt.target
      n.addClass("hl")
      n.connectedEdges().addClass("near")
    })
    S.graph.on("mouseout", "node", () => {
      S.graph.elements().removeClass("hl near")
    })
    S.graph.on("tap", "node", (evt: any) => showInfo(evt.target))
    S.graph.on("dbltap", "node", (evt: any) => {
      const n = evt.target
      if (n.data("type") === "memory") void openDetail(n.id().slice("memory:".length))
    })
    S.graph.on("tap", (evt: any) => {
      if (evt.target === S.graph) {
        info.hidden = true
        select(null)
      }
    })

    // 拖动节点：实时牵引邻居（Obsidian 的手感）
    S.graph.on("grab", "node", (evt: any) => {
      const sn = S.simNodes.get(evt.target.id())
      if (!sn || !S.sim) return
      sn.fx = sn.x
      sn.fy = sn.y
      S.sim.alphaTarget(0.45).restart()
    })
    S.graph.on("drag", "node", (evt: any) => {
      const sn = S.simNodes.get(evt.target.id())
      if (!sn) return
      const p = evt.target.position()
      sn.fx = p.x
      sn.fy = p.y
    })
    S.graph.on("free", "node", (evt: any) => {
      const sn = S.simNodes.get(evt.target.id())
      if (!sn) return
      sn.fx = null
      sn.fy = null
      S.sim?.alphaTarget(0)
      syncLabels()
    })

    // 固定初始位置，保证每次打开布局一致
    const all = S.graph.nodes()
    const radius = Math.max(90, Math.sqrt(all.length) * 26)
    all.forEach((n: any, i: number) => {
      const a = i * 2.399963 + seedHash(n.id()) * 0.9
      const r = radius * Math.sqrt((i + 0.5) / all.length) * (0.7 + seedHash(n.id() + "r") * 0.55)
      n.position({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    })

    applySearch()
    applyVisibility(true)
    ;(window as any).__amcy = S.graph
    ;(window as any).__amS = S
  }

  const load = async () => {
    const g = (document.getElementById("ggroup") as HTMLSelectElement).value
    S.graphFocus = null
    info.hidden = true
    select(null)
    canvas.innerHTML = `<div class="loading"><div class="spinner"></div></div>`
    S.graphData = await api("/graph" + (g ? "?group=" + encodeURIComponent(g) : ""))
    draw()
  }

  document.getElementById("ggroup")?.addEventListener("change", () => void load())
  document.getElementById("glayout")?.addEventListener("change", (e) => {
    S.graphLayout = (e.target as HTMLSelectElement).value
    syncForceEnabled()
    applyVisibility(false, false)
    runLayout()
  })
  document.getElementById("gfit")?.addEventListener("click", () => S.graph?.fit(undefined, 30))
  document.getElementById("gzoomin")?.addEventListener("click", () =>
    S.graph?.zoom({ level: S.graph.zoom() * 1.25, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } })
  )
  document.getElementById("gzoomout")?.addEventListener("click", () =>
    S.graph?.zoom({ level: S.graph.zoom() / 1.25, renderedPosition: { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 } })
  )
  document.getElementById("gexport")?.addEventListener("click", () => {
    if (!S.graph) return
    try {
      const png = S.graph.png({ scale: 2, full: true, bg: getComputedStyle(document.body).backgroundColor })
      const a = document.createElement("a")
      a.href = png
      a.download = `memory-graph-${new Date().toISOString().slice(0, 10)}.png`
      a.click()
      toast("已导出 PNG")
    } catch (err) {
      toast((err as Error).message, "error")
    }
  })
  document.getElementById("gfull")?.addEventListener("click", () => {
    document.getElementById("graph-card")!.classList.toggle("fullscreen")
    setTimeout(() => {
      S.graph?.resize()
      fitCapped()
    }, 90)
  })
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !S.view || S.view !== "graph") return
    const pop = document.getElementById("gforce-pop")
    if (pop && !pop.hidden) {
      pop.hidden = true
      return
    }
    const card = document.getElementById("graph-card")
    if (card?.classList.contains("fullscreen")) {
      card.classList.remove("fullscreen")
      setTimeout(() => {
        S.graph?.resize()
        fitCapped()
      }, 90)
      return
    }
    if (!info.hidden) {
      info.hidden = true
      select(null)
    } else if (S.graphFocus) {
      S.graphFocus = null
      applyVisibility()
    }
  })

  document.getElementById("greset")?.addEventListener("click", () => {
    S.graphFocus = null
    applyVisibility()
    if (selNode) showInfo(selNode)
  })

  const applySearch = () => {
    const cy = S.graph
    if (!cy) return
    const q = S.graphSearch.toLowerCase()
    cy.batch(() => {
      cy.nodes().forEach((n: any) =>
        n.toggleClass("dim", !!q && !String(n.data("label")).toLowerCase().includes(q))
      )
      cy.edges().forEach((e: any) =>
        e.toggleClass("dim", !!q && (e.source().hasClass("dim") || e.target().hasClass("dim")))
      )
    })
    updateHint()
  }

  const search = document.getElementById("gsearch") as HTMLInputElement
  search.addEventListener("input", () => {
    S.graphSearch = search.value.trim()
    if (!S.graph) return
    S.graph.elements().removeClass("hl hoverdim")
    applySearch()
  })
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !S.graph) return
    const q = search.value.trim().toLowerCase()
    const hit = S.graph
      .nodes()
      .filter(
        (n: any) =>
          String(n.data("label")).toLowerCase().includes(q) &&
          n.style("display") !== "none" &&
          !n.hasClass("dim")
      )[0]
    if (hit) {
      S.graph.elements().removeClass("hl hoverdim")
      S.graph.animate({ center: { eles: hit }, zoom: 1.2, duration: 180 })
      hit.closedNeighborhood().addClass("hl")
      showInfo(hit)
    }
  })

  await load()
}


async function renderGroups() {
  const data = await api("/groups")
  const groups: Group[] = data.groups || []

  // OpenChamber 的项目与会话：选目录，不再手敲路径
  let projects: any[] = []
  let sessions: any[] = []
  try {
    const snap = await host.listProjects()
    projects = snap.projects || []
    const snaps = await Promise.all(projects.map((p) => host.listSessions(p.id).catch(() => ({ sessions: [] }))))
    sessions = snaps.flatMap((x: any) => x.sessions || [])
    sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  } catch {
    projects = []
    sessions = []
  }
  const manual = groups.filter((g) => g.kind === "manual")
  const projectById = new Map(projects.map((p) => [p.id, p]))
  const sessionById = new Map(sessions.map((x) => [x.id, x]))
  const targetOpts = [
    ...manual.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}（${esc(g.id)}）</option>`),
    `<option value="__new">新建组（填入下方）</option>`,
  ].join("")
  const projectOpts = projects
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.directory)}</option>`)
    .join("")
  const sessionOption = (x: any) =>
    `<option value="${esc(x.id)}" data-dir="${esc(x.directory)}" data-project="${esc(x.projectId)}">${esc(x.title || x.id)} · ${esc(x.directory)}${x.archivedAt ? " · 已归档" : ""}</option>`
  const sessionOpts = sessions.slice(0, 120).map(sessionOption).join("")

  const pathChips = (paths: string[]) =>
    paths.length
      ? paths
          .map(
            (p) =>
              `<span class="path-chip"><span title="${esc(p)}">${esc(p)}</span><button type="button" data-rm="${esc(p)}" aria-label="移除 ${esc(p)}">×</button></span>`
          )
          .join("")
      : `<span class="path-empty">还没有目录</span>`

  const editors = manual
    .map(
      (g, i) => `<form class="card group-card" data-group="${esc(g.id)}">
        <div class="card-head">
          <h3 class="group-id">${esc(g.id)}</h3><span class="tag">目录组</span>
          <div class="spacer"></div><span class="aside">${g.n} 条</span>
        </div>
        <input class="group-title" id="gname-${i}" name="name" value="${esc(g.name)}" placeholder="显示名称" aria-label="显示名称">
        <label class="field-label" style="margin-top:12px">目录</label>
        <div class="path-chips" data-chips>${pathChips(g.paths)}</div>
        <textarea name="paths" hidden>${esc(g.paths.join("\n"))}</textarea>
        <div class="path-add">
          <input class="field" name="newpath" placeholder="添加路径，回车">
          <button class="btn sm accent" type="button" data-add-path>加入</button>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn sm primary" type="submit">保存</button>
          <span class="hint">保存后新会话生效</span>
        </div>
      </form>`
    )
    .join("")

  const picker = projects.length
    ? `<div class="card" id="oc-picker">
        <div class="card-head"><h3>从 OpenChamber 添加</h3><div class="spacer"></div><span class="aside">项目 / 会话</span></div>
        <div class="hint">选中项目或会话，把所在目录加入目标组；路径只是写进表单，点该组的“保存”后才生效。</div>
        <label class="field-label" style="margin-top:10px">目标组</label>
        <select class="field" id="pick-target" aria-label="目标组">${targetOpts}</select>
        <div class="picker-grid">
          <label><span>项目</span><select class="field" id="pick-project"><option value="">选择项目…</option>${projectOpts}</select></label>
          <label><span>会话</span><select class="field" id="pick-session"><option value="">选择会话…</option>${sessionOpts}</select></label>
        </div>
        <div class="picker-actions">
          <button class="btn sm accent" id="add-project" type="button">加入项目目录</button>
          <button class="btn sm accent" id="add-session" type="button">加入会话目录</button>
        </div>
      </div>`
    : `<div class="card"><div class="card-head"><h3>从 OpenChamber 添加</h3></div>
        <div class="hint">没有读到 OpenChamber 项目。需要 sessions 能力：重新加载本扩展并授权后可用。</div></div>`

  main.innerHTML = `
    <div class="hint">路径支持 * 与 **；未命中的目录会自动成为独立组。重复路径会被拒绝。</div>
    ${picker}
    ${editors || empty("还没有手动配置的组", "folder")}
    <form class="card group-card" data-group="__new">
      <div class="card-head"><h3>新建组</h3><div class="spacer"></div><span class="aside">目录匹配</span></div>
      <div class="group-grid">
        <label><span class="field-label">id</span><input class="field mono" name="id" placeholder="英文，如 fuzz"></label>
        <label><span class="field-label">名称</span><input class="field" name="name" placeholder="显示名称"></label>
      </div>
      <label class="field-label" style="margin-top:10px">目录</label>
      <div class="path-chips" data-chips><span class="path-empty">还没有目录</span></div>
      <textarea name="paths" hidden></textarea>
      <div class="path-add">
        <input class="field" name="newpath" placeholder="添加路径，回车">
        <button class="btn sm accent" type="button" data-add-path>加入</button>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn sm primary" type="submit">${icon("plus", 12)} 创建</button></div>
    </form>`

  const readPaths = (form: HTMLFormElement) => {
    const ta = form.querySelector('textarea[name="paths"]') as HTMLTextAreaElement
    return ta.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  }
  const writePaths = (form: HTMLFormElement, paths: string[]) => {
    const ta = form.querySelector('textarea[name="paths"]') as HTMLTextAreaElement
    ta.value = paths.join("\n")
    const box = form.querySelector("[data-chips]") as HTMLElement
    box.innerHTML = pathChips(paths)
    box.querySelectorAll("[data-rm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const p = (btn as HTMLElement).dataset.rm || ""
        writePaths(form, readPaths(form).filter((x) => x !== p))
      })
    )
  }
  const addPath = (form: HTMLFormElement, raw: string) => {
    const clean = String(raw || "").replace(/\\/g, "/").replace(/\/+$/, "").trim()
    if (!clean) return
    const paths = readPaths(form)
    const same = paths.some(
      (x) => x.replace(/\/+$/, "") === clean || x.replace(/\/+$/, "") === clean + "/**"
    )
    if (same) {
      toast("这个目录已经在路径里")
      return
    }
    writePaths(form, [...paths, clean])
    toast("已加入路径，点保存生效")
  }

  const pickTarget = document.getElementById("pick-target") as HTMLSelectElement | null
  const pickProject = document.getElementById("pick-project") as HTMLSelectElement | null
  const pickSession = document.getElementById("pick-session") as HTMLSelectElement | null
  const targetForm = () =>
    [...main.querySelectorAll("form[data-group]")].find(
      (f) => (f as HTMLFormElement).dataset.group === pickTarget?.value
    ) as HTMLFormElement | undefined
  const appendPath = (dir: string) => {
    const form = targetForm()
    if (!form || !dir) return
    form.dispatchEvent(new CustomEvent("am-add-path", { detail: dir }))
    form.scrollIntoView({ behavior: "smooth", block: "center" })
  }
  pickProject?.addEventListener("change", () => {
    if (!pickSession) return
    const pid = pickProject.value
    const list = pid ? sessions.filter((x) => x.projectId === pid) : sessions
    pickSession.innerHTML =
      `<option value="">选择会话…</option>` + list.slice(0, 120).map(sessionOption).join("")
  })
  document.getElementById("add-project")?.addEventListener("click", () => {
    const p = projectById.get(pickProject?.value || "")
    if (!p) return toast("先选一个项目", "error")
    appendPath(p.directory)
  })
  document.getElementById("add-session")?.addEventListener("click", () => {
    const x = sessionById.get(pickSession?.value || "")
    if (!x) return toast("先选一个会话", "error")
    appendPath(x.directory)
  })

  main.querySelectorAll("form[data-group]").forEach((form) => {
    const f = form as HTMLFormElement
    writePaths(f, readPaths(f))
    const input = f.querySelector('input[name="newpath"]') as HTMLInputElement | null
    f.querySelector("[data-add-path]")?.addEventListener("click", () => {
      if (!input) return
      addPath(f, input.value)
      input.value = ""
      input.focus()
    })
    input?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return
      e.preventDefault()
      addPath(f, input.value)
      input.value = ""
    })
    f.addEventListener("am-add-path", (e) => addPath(f, (e as CustomEvent).detail))
    f.addEventListener("submit", async (e) => {
      e.preventDefault()
      const id = f.dataset.group === "__new" ? (f.elements.namedItem("id") as HTMLInputElement).value.trim() : f.dataset.group!
      const name = (f.elements.namedItem("name") as HTMLInputElement).value.trim()
      const paths = readPaths(f)
      try {
        const r = await api("/group-save", "POST", { id, name, paths })
        if (!r.ok) throw new Error(r.error || "保存失败")
        toast("已保存")
        await loadStatus()
        void renderGroups()
      } catch (err) {
        toast((err as Error).message, "error")
      }
    })
  })
}

async function renderEvents() {
  const st = S.status || (await loadStatus())
  const data = await api("/events?limit=300" + (S.eventGroup ? `&group=${encodeURIComponent(S.eventGroup)}` : ""))
  const all = data.rows || []
  const actions = [...new Set(all.map((e: any) => e.action))].sort()
  const rows = S.eventAction ? all.filter((e: any) => e.action === S.eventAction) : all

  const groupOpts = [`<option value="">全部组</option>`]
    .concat(st.groups.map((g) => `<option value="${esc(g.id)}" ${S.eventGroup === g.id ? "selected" : ""}>${esc(g.name)}</option>`))
    .join("")
  const actionOpts = [`<option value="">全部动作</option>`]
    .concat(actions.map((a: string) => `<option value="${esc(a)}" ${S.eventAction === a ? "selected" : ""}>${esc(a)}</option>`))
    .join("")

  const tone: Record<string, string> = {
    capture: "primary", promote: "success", forget: "error", conflict: "error",
    archive: "warning", expire: "warning", backup: "info", maintain: "info",
  }

  main.innerHTML = `
    <div class="filters">
      <select class="field" id="egroup">${groupOpts}</select>
      <select class="field" id="eaction">${actionOpts}</select>
    </div>
    <div class="card"><div class="timeline">
      ${rows
        .map(
          (e: any) => `<div class="tl-item" data-tone="${tone[e.action] || ""}">
            <span class="tl-time">${fmtTime(e.created_at)}</span>
            <div class="grow">
              <div class="tl-act">${tag(actionLabel(e.action), tone[e.action] || "")}</div>
              <div class="tl-group mono">${esc(e.group_id || "-")} · ${esc(e.actor)}</div>
            </div>
          </div>`
        )
        .join("") || `<div class="hint">暂无事件</div>`}
    </div></div>`

  ;(document.getElementById("egroup") as HTMLSelectElement).addEventListener("change", (e) => {
    S.eventGroup = (e.target as HTMLSelectElement).value
    void renderEvents()
  })
  ;(document.getElementById("eaction") as HTMLSelectElement).addEventListener("change", (e) => {
    S.eventAction = (e.target as HTMLSelectElement).value
    void renderEvents()
  })
}

async function renderStats() {
  const data = await api("/stats")
  const s = data.stats
  const rows = data.rollups || []
  main.innerHTML = `
    <div class="grid2">
      <div class="stat"><span>总记忆</span><b>${s.memories}</b></div>
      <div class="stat"><span>已生效</span><b>${s.promoted}</b></div>
      <div class="stat"><span>草稿</span><b>${s.drafts}</b></div>
      <div class="stat"><span>归档</span><b>${s.archived}</b></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>事件汇总（90 天前）</h3></div>
      ${rows.length
        ? rows.slice(0, 30).map((r: any) => `<div class="row"><span class="mono meta">${esc(r.day)}</span><div class="grow">${esc(r.action)}</div><span class="tag">${r.n}</span></div>`).join("")
        : `<div class="hint">还没有 rollup（事件超过 90 天后生成）</div>`}
    </div>`
}

/* ── 详情抽屉 ─────────────────────────────────────────────────────── */
async function openDetail(id: string) {
  try {
    const m = (await api("/memory?id=" + encodeURIComponent(id))) as Row
    if (!m || (m as any).error) throw new Error("未找到该记忆")
    const src = (() => { try { return JSON.parse(m.source_json) } catch { return {} } })()
    const rel = await api("/related?id=" + encodeURIComponent(m.id)).catch(() => ({ items: [] }))
    const relHtml = (rel.items || [])
      .map((x: any) =>
        x.memoryId
          ? `<button class="chip" data-rel-memory="${esc(x.memoryId)}" title="${esc(x.predicate)}">${esc(x.label)}</button>`
          : `<span class="chip muted" title="${esc(x.predicate)}">${esc(x.label)}</span>`
      )
      .join("")
    const events = (m.events || [])
      .map((e: any) => `<div class="tl-item"><span class="tl-time">${fmtTime(e.created_at)}</span><div class="grow"><div class="tl-act">${esc(actionLabel(e.action))}</div><div class="tl-group">${esc(e.actor)}</div></div></div>`)
      .join("")

    sheet.innerHTML = `
      <div class="sheet-head">
        <h2>记忆详情</h2>
        ${tag(STATUS[m.status]?.label || m.status, STATUS[m.status]?.tone || "")}
        <div class="spacer" style="flex:1"></div>
        <button class="btn icon ghost" id="close-sheet" aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="sheet-body">
        <div class="sheet-section">
          <div class="meta" style="margin-bottom:4px">${esc(groupName(m.group_id))} · ${esc(KIND[m.kind] || m.kind)} · 置信 ${Math.round(m.confidence * 100)}% · 命中 ${m.hits}${m.pinned ? " · 已置顶" : ""}${m.valid_to ? ` · 已失效（${fmtAgo(m.valid_to)}）` : ""}${m.last_seen_at ? ` · 最近确认 ${fmtAgo(m.last_seen_at)}` : ""}${m.last_injected_at ? ` · 最近注入 ${fmtAgo(m.last_injected_at)}` : ""}${(m.kind === "progress" || m.kind === "summary") && Date.now() - (m.last_seen_at || m.updated_at) > 14 * 86_400_000 ? " · 未复核" : ""} · <span class="mono">${esc(m.id)}</span></div>
          <form id="edit-form">
            <textarea class="field" name="content" rows="3" maxlength="300">${esc(m.content)}</textarea>
            <textarea class="field" name="detail" rows="3" placeholder="展开（可选）" style="margin-top:6px">${esc(m.detail || "")}</textarea>
            <div class="row" style="margin-top:8px">
              <button class="btn sm primary" type="submit">保存修改</button>
            </div>
          </form>
        </div>

        <div class="sheet-section">
          <h4>操作</h4>
          <div class="row" style="flex-wrap:wrap">
            ${m.status === "draft" || m.status === "conflicted" ? `<button class="btn sm primary" data-sheet-act="promote">晋升</button>` : ""}
            ${m.status === "promoted" ? `<button class="btn sm" data-sheet-act="demote">降回草稿</button>` : ""}
            ${m.status === "promoted" ? `<button class="btn sm" data-sheet-act="${m.pinned ? "unpin" : "pin"}">${m.pinned ? "取消置顶" : "置顶"}</button>` : ""}
            ${m.status !== "archived" ? `<button class="btn sm danger" data-sheet-act="forget">遗忘</button>` : ""}
            ${m.status === "archived" ? `<button class="btn sm" data-sheet-act="restore">恢复</button>` : ""}
          </div>
        </div>

        <div class="sheet-section">
          <h4>来源</h4>
          <div class="kv">
            <div><span>会话</span><span class="mono">${esc(src.session_id || "-")}</span></div>
            <div><span>目录</span><span class="mono">${esc(src.dir || "-")}</span></div>
          </div>
          ${src.evidence ? `<blockquote class="quote" style="margin-top:7px">${esc(src.evidence)}</blockquote>` : ""}
        </div>

        <div class="sheet-section">
          <h4>关联</h4>
          <div class="chips">${relHtml || `<span class="hint">没有关联节点</span>`}</div>
        </div>

        <div class="sheet-section">
          <h4>事件</h4>
          <div class="timeline">${events || `<div class="hint">无</div>`}</div>
        </div>
      </div>`

    sheet.classList.add("open")
    backdrop.classList.add("open")
    ;(document.getElementById("close-sheet") as HTMLButtonElement | null)?.focus()

    document.getElementById("close-sheet")?.addEventListener("click", closeSheet)
    sheet.querySelectorAll("[data-rel-memory]").forEach((el) =>
      el.addEventListener("click", () => {
        const mid = (el as HTMLElement).dataset.relMemory!
        void openDetail(mid)
      })
    )
    ;(document.getElementById("edit-form") as HTMLFormElement).addEventListener("submit", async (e) => {
      e.preventDefault()
      const f = e.target as HTMLFormElement
      const content = (f.elements.namedItem("content") as HTMLTextAreaElement).value
      const detail = (f.elements.namedItem("detail") as HTMLTextAreaElement).value
      try {
        await api("/edit", "POST", { id: m.id, content, detail })
        toast("已保存")
        await openDetail(m.id)
        void loadStatus()
      } catch (err) {
        toast((err as Error).message, "error")
      }
    })
    sheet.querySelectorAll("[data-sheet-act]").forEach((el) =>
      el.addEventListener("click", async () => {
        const action = (el as HTMLElement).dataset.sheetAct!
        try {
          await api("/action", "POST", { action, id: m.id })
          toast("已" + ({ promote: "晋升", demote: "降级", forget: "遗忘", restore: "恢复", pin: "置顶", unpin: "取消置顶" } as any)[action])
          closeSheet()
          await loadStatus()
          void render()
        } catch (err) {
          toast((err as Error).message, "error")
        }
      })
    )
  } catch (err) {
    toast((err as Error).message, "error")
  }
}

function closeSheet() {
  sheet.classList.remove("open")
  backdrop.classList.remove("open")
}

/* ── 事件委托 ─────────────────────────────────────────────────────── */
function bindDelegates() {
  document.addEventListener("click", (e) => {
    const pop = document.getElementById("gforce-pop")
    if (!pop || pop.hidden) return
    const target = e.target as HTMLElement
    if (pop.contains(target) || target.closest("#gforce")) return
    pop.hidden = true
  })
  main.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement
    const actEl = target.closest("[data-act]") as HTMLElement | null
    if (actEl) {
      e.stopPropagation()
      const action = actEl.dataset.act!
      const id = actEl.dataset.id!
      try {
        await api("/action", "POST", { action, id })
        toast("已" + ({ promote: "晋升", forget: "遗忘", restore: "恢复", demote: "降级" } as any)[action])
        await loadStatus()
        void render()
      } catch (err) {
        toast((err as Error).message, "error")
      }
      return
    }

    const resolveEl = target.closest("[data-resolve]") as HTMLElement | null
    if (resolveEl) {
      const pair = S.pairs[Number(resolveEl.dataset.resolve)]
      const keep = resolveEl.dataset.keep === "a" ? pair.a.id : pair.b.id
      const drop = resolveEl.dataset.keep === "a" ? pair.b.id : pair.a.id
      try {
        await api("/resolve", "POST", { keep, drop })
        toast("已裁决")
        await loadStatus()
        void render()
      } catch (err) {
        toast((err as Error).message, "error")
      }
      return
    }

    const openEl = target.closest("[data-open]") as HTMLElement | null
    if (openEl) void openDetail(openEl.dataset.open!)
  })

  main.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement
    if ((e.key === "Enter" || e.key === " ") && el.matches('.item[data-open]')) {
      e.preventDefault()
      void openDetail(el.dataset.open!)
    }
  })

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) closeSheet()
  })
}

/* ── 启动 ─────────────────────────────────────────────────────────── */
host.onReady((context: any) => {
  if (!PREVIEW) applyHostReady(context, document.documentElement)
  if (mounted) return
  mounted = true
  mount()
})
