// 服务端渲染页面。样式复用 Tabler（MIT），交互复用 HTMX（BSD-2）。
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))

const NAV = [
  ["/", "总览"],
  ["/memories", "记忆"],
  ["/drafts", "草稿"],
  ["/graph", "图谱"],
  ["/groups", "记忆组"],
  ["/conflicts", "冲突"],
  ["/events", "事件流"],
  ["/stats", "统计"],
]

export function layout({ title, active = "/", content }) {
  const nav = NAV.map(([href, label]) =>
    `<li class="nav-item"><a class="${href === active ? "nav-link active" : "nav-link"}" href="${href}">${label}</a></li>`
  ).join("")

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · agent-memory</title>
  <link rel="stylesheet" href="/assets/tabler.min.css">
  <script src="/assets/htmx.min.js" defer></script>
  <style>
    body { background: #f6f7f9; }
    .page-body { padding-top: 1.25rem; }
    .num { font-variant-numeric: tabular-nums; }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .85em; }
    .memo { max-width: 60ch; }
    .status-dot { width: .6rem; height: .6rem; border-radius: 50%; display: inline-block; }
    .table-sm td, .table-sm th { padding: .45rem .5rem; }
  </style>
</head>
<body>
<div class="page">
  <header class="navbar navbar-expand-md navbar-light d-print-none">
    <div class="container-xl">
      <div class="navbar-brand navbar-brand-autodark d-flex align-items-center gap-2">
        <strong>agent-memory</strong>
        <span class="badge bg-secondary-lt">v0.3</span>
      </div>
    </div>
  </header>
  <div class="container-xl"><ul class="nav nav-tabs mt-2">${nav}</ul></div>
  <div class="page-wrapper"><div class="page-body"><div class="container-xl">${content}</div></div></div>
</div>
</body>
</html>`
}

function bytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function statCard(label, value, hint = "") {
  return `<div class="col-sm-6 col-lg-3">
    <div class="card"><div class="card-body">
      <div class="text-secondary small">${esc(label)}</div>
      <div class="h1 mb-1 num">${esc(value)}</div>
      <div class="text-secondary small">${esc(hint)}</div>
    </div></div>
  </div>`
}

const STATUS_BADGE = {
  promoted: ["已生效", "success"],
  draft: ["草稿", "warning"],
  conflicted: ["冲突", "danger"],
  archived: ["已归档", "secondary"],
}

function badge(status) {
  const [label, tone] = STATUS_BADGE[status] || [status, "secondary"]
  return `<span class="badge bg-${tone}-lt">${esc(label)}</span>`
}

function actionForm(action, id, label, variant = "outline", next = "") {
  return `<form method="post" action="/actions/${action}" class="d-inline">
    <input type="hidden" name="id" value="${esc(id)}">
    <input type="hidden" name="next" value="${esc(next)}">
    <button class="btn btn-sm btn-${variant}" type="submit">${esc(label)}</button>
  </form>`
}

export function statusPage({ stats, dbSize, dbPath, driver, heartbeat, groups, events, budget }) {
  const sizePct = Math.min(100, Math.round((dbSize / (budget.softMb * 1024 * 1024)) * 100))
  const age = heartbeat?.at ? Date.now() - heartbeat.at : null
  const ok = age !== null && age < 10 * 60 * 1000
  const ageText = age === null ? "未上报" : ok ? `${Math.round(age / 1000)} 秒前` : `${Math.round(age / 60000)} 分钟前`

  const groupRows = groups.length
    ? groups.map((g) => `<tr>
        <td class="mono">${esc(g.id)}</td><td>${esc(g.name)}</td>
        <td><span class="badge bg-${g.kind === "manual" ? "blue" : "secondary"}-lt">${esc(g.kind)}</span></td>
        <td class="num">${esc(g.n)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="text-secondary">还没有记忆组。</td></tr>`

  const eventRows = events.length
    ? events.map((e) => `<tr>
        <td class="text-secondary mono">${esc(new Date(e.created_at).toLocaleString("zh-CN"))}</td>
        <td>${esc(e.action)}</td><td class="mono">${esc(e.group_id || "-")}</td>
        <td class="text-secondary">${esc(e.actor)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="text-secondary">暂无事件。</td></tr>`

  const content = `
  <div class="row row-cards">
    ${statCard("长期记忆", stats.promoted, `共 ${stats.memories} 条`)}
    ${statCard("草稿", stats.drafts, "7 天未晋升会过期")}
    ${statCard("记忆组", stats.groups, "项目按组隔离")}
    ${statCard("图谱", `${stats.entities} / ${stats.edges}`, "节点 / 边")}
  </div>
  <div class="row row-cards mt-1">
    <div class="col-lg-8"><div class="card"><div class="card-header"><h3 class="card-title">存储预算</h3></div>
      <div class="card-body">
        <div class="d-flex justify-content-between mb-1"><span class="text-secondary mono">${esc(dbPath)}</span>
          <span class="num">${bytes(dbSize)} / ${budget.softMb} MB</span></div>
        <div class="progress progress-sm"><div class="progress-bar bg-${sizePct > 80 ? "danger" : sizePct > 50 ? "warning" : "success"}" style="width:${sizePct}%"></div></div>
        <div class="text-secondary small mt-2">硬预算 ${budget.hardMb} MB · SQLite 驱动 <span class="mono">${esc(driver)}</span></div>
      </div></div>
    </div>
    <div class="col-lg-4"><div class="card"><div class="card-header"><h3 class="card-title">插件心跳</h3></div>
      <div class="card-body">
        <div class="d-flex align-items-center gap-2"><span class="status-dot ${ok ? "bg-success" : "bg-danger"}"></span><strong>${ok ? "在线" : "未确认"}</strong></div>
        <div class="text-secondary small mt-2">${esc(ageText)}${heartbeat?.host ? ` · ${esc(heartbeat.host)}` : ""}</div>
        <div class="text-secondary small">上次捕获：${heartbeat?.lastCaptureAt ? esc(new Date(heartbeat.lastCaptureAt).toLocaleString("zh-CN")) : "从未"}</div>
      </div></div>
    </div>
  </div>
  <div class="card mt-3"><div class="card-header"><h3 class="card-title">记忆组</h3></div>
    <div class="table-responsive"><table class="table table-vcenter card-table table-sm">
      <thead><tr><th>ID</th><th>名称</th><th>类型</th><th>记忆数</th></tr></thead><tbody>${groupRows}</tbody></table></div></div>
  <div class="card mt-3"><div class="card-header"><h3 class="card-title">最近事件</h3></div>
    <div class="table-responsive"><table class="table table-vcenter card-table table-sm">
      <thead><tr><th>时间</th><th>动作</th><th>组</th><th>来源</th></tr></thead><tbody>${eventRows}</tbody></table></div></div>`
  return layout({ title: "总览", active: "/", content })
}

function filterBar({ filters, groups, action = "/memories", showStatus = true }) {
  const groupOpts = [`<option value="">全部组</option>`]
    .concat(groups.map((g) => `<option value="${esc(g.id)}" ${filters.group === g.id ? "selected" : ""}>${esc(g.name)} (${esc(g.id)})</option>`))
    .join("")
  const statusOpts = showStatus
    ? ["", "promoted", "draft", "conflicted", "archived"]
        .map((s) => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s ? (STATUS_BADGE[s]?.[0] || s) : "全部状态"}</option>`)
        .join("")
    : ""
  return `<form class="row g-2 mb-3" method="get" action="${action}">
    <div class="col-auto"><input class="form-control" name="q" placeholder="搜索记忆…" value="${esc(filters.q || "")}"></div>
    <div class="col-auto"><select class="form-select" name="group">${groupOpts}</select></div>
    ${showStatus ? `<div class="col-auto"><select class="form-select" name="status">${statusOpts}</select></div>` : ""}
    <div class="col-auto"><button class="btn btn-primary" type="submit">筛选</button></div>
  </form>`
}

export function memoriesPage({ rows, total, page, filters, groups }) {
  const body = rows.length
    ? rows.map((m) => `<tr>
        <td>${badge(m.status)}</td>
        <td class="mono">${esc(m.group_id)}</td>
        <td>${esc(m.kind)}</td>
        <td class="memo"><a href="/memories/${esc(m.id)}">${esc(m.content)}</a></td>
        <td class="num">${esc(m.confidence)}</td>
        <td class="num">${esc(m.hits)}</td>
        <td class="text-secondary mono">${esc(new Date(m.updated_at).toLocaleDateString("zh-CN"))}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" class="text-secondary">没有匹配的记忆。</td></tr>`

  const pages = Math.max(1, Math.ceil(total / 30))
  const qs = (p) => {
    const u = new URLSearchParams()
    if (filters.group) u.set("group", filters.group)
    if (filters.status) u.set("status", filters.status)
    if (filters.q) u.set("q", filters.q)
    u.set("page", String(p))
    return "/memories?" + u.toString()
  }

  const content = `
  ${filterBar({ filters, groups })}
  <div class="card"><div class="table-responsive"><table class="table table-vcenter card-table table-sm">
    <thead><tr><th>状态</th><th>组</th><th>类型</th><th>内容</th><th>置信</th><th>命中</th><th>更新</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <div class="card-footer d-flex align-items-center">
      <span class="text-secondary">共 ${total} 条 · 第 ${page}/${pages} 页</span>
      <div class="ms-auto btn-list">
        ${page > 1 ? `<a class="btn btn-sm" href="${qs(page - 1)}">上一页</a>` : ""}
        ${page < pages ? `<a class="btn btn-sm" href="${qs(page + 1)}">下一页</a>` : ""}
      </div>
    </div></div>`
  return layout({ title: "记忆", active: "/memories", content })
}

export function draftsPage({ rows, groups }) {
  const body = rows.length
    ? rows.map((m) => `<tr>
        <td class="mono">${esc(m.group_id)}</td>
        <td>${esc(m.kind)}</td>
        <td class="memo"><a href="/memories/${esc(m.id)}">${esc(m.content)}</a></td>
        <td class="num">${esc(m.confidence)}</td>
        <td class="text-secondary">${esc(m.expires_at ? new Date(m.expires_at).toLocaleDateString("zh-CN") : "-")}</td>
        <td class="text-nowrap">
          ${actionForm("promote", m.id, "晋升", "success", "/drafts")}
          ${actionForm("forget", m.id, "丢弃", "outline", "/drafts")}
        </td></tr>`).join("")
    : `<tr><td colspan="6" class="text-secondary">没有待处理的草稿。会话空闲时会自动捕获。</td></tr>`

  const content = `
  <div class="alert alert-info">草稿不会被注入。晋升后才进入长期记忆；7 天未处理会自动过期。</div>
  <div class="card"><div class="table-responsive"><table class="table table-vcenter card-table table-sm">
    <thead><tr><th>组</th><th>类型</th><th>内容</th><th>置信</th><th>过期</th><th>操作</th></tr></thead>
    <tbody>${body}</tbody></table></div></div>`
  return layout({ title: "草稿", active: "/drafts", content })
}

export function memoryPage({ m, groupName }) {
  const src = (() => { try { return JSON.parse(m.source_json) } catch { return {} } })()
  const events = (m.events || []).map((e) => `<tr>
      <td class="mono text-secondary">${esc(new Date(e.created_at).toLocaleString("zh-CN"))}</td>
      <td>${esc(e.action)}</td><td>${esc(e.actor)}</td>
      <td class="mono text-secondary">${esc(e.detail_json || "")}</td></tr>`).join("")

  const actions = [
    m.status === "draft" ? actionForm("promote", m.id, "晋升", "success", `/memories/${m.id}`) : "",
    m.status === "promoted" ? actionForm("demote", m.id, "降回草稿", "outline", `/memories/${m.id}`) : "",
    m.status !== "archived" ? actionForm("forget", m.id, "遗忘", "danger", `/memories/${m.id}`) : "",
    m.status === "archived" ? actionForm("restore", m.id, "恢复", "outline", `/memories/${m.id}`) : "",
  ].join(" ")

  const content = `
  <div class="mb-3"><a href="/memories" class="btn btn-sm btn-outline-secondary">← 返回列表</a></div>
  <div class="card">
    <div class="card-header d-flex align-items-center">
      <h3 class="card-title mb-0">${badge(m.status)} <span class="ms-2">${esc(m.content)}</span></h3>
      <div class="ms-auto btn-list">${actions}</div>
    </div>
    <div class="card-body">
      <div class="mb-3 text-secondary small">
        组 <span class="mono">${esc(m.group_id)}</span>（${esc(groupName)}） · 类型 ${esc(m.kind)} · 置信 ${esc(m.confidence)} · 命中 ${esc(m.hits)}
      </div>
      ${m.detail ? `<p class="memo">${esc(m.detail)}</p>` : ""}
      <form method="post" action="/actions/edit" class="row g-2">
        <input type="hidden" name="id" value="${esc(m.id)}">
        <input type="hidden" name="next" value="/memories/${esc(m.id)}">
        <div class="col-12"><label class="form-label">内容（≤300 字）</label>
          <input class="form-control" name="content" value="${esc(m.content)}" maxlength="300"></div>
        <div class="col-12"><label class="form-label">展开（≤2000 字）</label>
          <textarea class="form-control" name="detail" rows="3">${esc(m.detail || "")}</textarea></div>
        <div class="col-auto"><button class="btn btn-primary" type="submit">保存修改</button></div>
      </form>
    </div>
    <div class="card-body border-top">
      <h4>来源</h4>
      <div class="text-secondary small mono">session: ${esc(src.session_id || "-")}</div>
      <div class="text-secondary small mono">dir: ${esc(src.dir || "-")}</div>
      <blockquote class="blockquote mt-2 mb-0"><p class="mb-0">${esc(src.evidence || "（无原话证据）")}</p></blockquote>
    </div>
    <div class="card-body border-top">
      <h4>事件</h4>
      <div class="table-responsive"><table class="table table-sm"><tbody>${events || "<tr><td class='text-secondary'>无</td></tr>"}</tbody></table></div>
    </div>
  </div>`
  return layout({ title: m.content.slice(0, 30), active: "/memories", content })
}

export function conflictsPage({ pairs }) {
  const body = pairs.length
    ? pairs.map((p) => `<tr>
        <td class="memo">
          <div class="mb-1">${esc(p.a.content)}</div>
          <div class="text-secondary small mono">${esc(p.a.id)} · ${esc(p.a.status)}</div>
        </td>
        <td class="text-center" style="width:9rem">
          <div class="text-secondary small mb-1">冲突</div>
          <form method="post" action="/actions/resolve" class="d-grid gap-1">
            <input type="hidden" name="keep" value="${esc(p.a.id)}"><input type="hidden" name="drop" value="${esc(p.b.id)}">
            <input type="hidden" name="next" value="/conflicts">
            <button class="btn btn-sm btn-success" type="submit">保留左</button>
          </form>
          <form method="post" action="/actions/resolve" class="d-grid gap-1 mt-1">
            <input type="hidden" name="keep" value="${esc(p.b.id)}"><input type="hidden" name="drop" value="${esc(p.a.id)}">
            <input type="hidden" name="next" value="/conflicts">
            <button class="btn btn-sm btn-outline-success" type="submit">保留右</button>
          </form>
        </td>
        <td class="memo">
          <div class="mb-1">${esc(p.b.content)}</div>
          <div class="text-secondary small mono">${esc(p.b.id)} · ${esc(p.b.status)}</div>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="3" class="text-secondary">没有待裁决的冲突。</td></tr>`

  const content = `
  <div class="alert alert-warning">冲突不会自动覆盖。选一边保留，另一边归档；裁决前后都不会注入。</div>
  <div class="card"><div class="table-responsive"><table class="table table-vcenter card-table table-sm">
    <thead><tr><th>记忆 A</th><th>操作</th><th>记忆 B</th></tr></thead>
    <tbody>${body}</tbody></table></div></div>`
  return layout({ title: "冲突", active: "/conflicts", content })
}

export function groupsPage({ groups }) {
  const rows = groups.map((g) => `<tr>
      <td class="mono">${esc(g.id)}</td><td>${esc(g.name)}</td>
      <td><span class="badge bg-${g.kind === "manual" ? "blue" : "secondary"}-lt">${esc(g.kind)}</span></td>
      <td class="num">${esc(g.n)}</td>
      <td class="mono small">${(g.paths || []).map((p) => esc(p)).join("<br>") || "-"}</td>
    </tr>`).join("")

  const editors = groups.filter((g) => g.kind === "manual").map((g) => `<form method="post" action="/actions/group-save" class="card card-body mb-2">
      <input type="hidden" name="id" value="${esc(g.id)}">
      <input type="hidden" name="next" value="/groups">
      <div class="row g-2">
        <div class="col-md-4"><label class="form-label">名称</label>
          <input class="form-control" name="name" value="${esc(g.name)}"></div>
        <div class="col-md-8"><label class="form-label">路径（每行一个，支持 * 与 **）</label>
          <textarea class="form-control mono" name="paths" rows="3">${esc((g.paths || []).join("\n"))}</textarea></div>
      </div>
      <div class="mt-2"><button class="btn btn-sm btn-primary" type="submit">保存「${esc(g.id)}」</button>
        <span class="text-secondary small ms-2">保存后新会话生效</span></div>
    </form>`).join("")

  const content = `
  <div class="alert alert-info">路径支持 <span class="mono">*</span>（单层）与 <span class="mono">**</span>（递归）；最长匹配优先。未命中的目录会自动成为独立组。</div>
  <div class="card mb-3"><div class="table-responsive"><table class="table table-vcenter card-table table-sm">
    <thead><tr><th>ID</th><th>名称</th><th>类型</th><th>记忆数</th><th>路径</th></tr></thead>
    <tbody>${rows || "<tr><td colspan='5' class='text-secondary'>暂无</td></tr>"}</tbody></table></div></div>

  <h3>编辑已有组</h3>
  ${editors || "<p class='text-secondary'>没有手动配置的组。</p>"}

  <h3 class="mt-4">新建组</h3>
  <form method="post" action="/actions/group-save" class="card card-body">
    <input type="hidden" name="next" value="/groups">
    <div class="row g-2">
      <div class="col-md-3"><label class="form-label">ID</label><input class="form-control mono" name="id" placeholder="fuzz" required></div>
      <div class="col-md-3"><label class="form-label">名称</label><input class="form-control" name="name" placeholder="协议模糊测试" required></div>
      <div class="col-md-6"><label class="form-label">路径（每行一个）</label>
        <textarea class="form-control mono" name="paths" rows="3" placeholder="D:/work/project-a/**"></textarea></div>
    </div>
    <div class="mt-2"><button class="btn btn-primary" type="submit">创建</button></div>
  </form>`
  return layout({ title: "记忆组", active: "/groups", content })
}

export function eventsPage({ rows, filters, groups }) {
  const body = rows.length
    ? rows.map((e) => `<tr>
        <td class="mono text-secondary">${esc(new Date(e.created_at).toLocaleString("zh-CN"))}</td>
        <td>${esc(e.action)}</td><td class="mono">${esc(e.group_id || "-")}</td>
        <td>${esc(e.actor)}</td><td class="mono text-secondary">${esc((e.detail_json || "").slice(0, 120))}</td></tr>`).join("")
    : `<tr><td colspan="5" class="text-secondary">暂无事件</td></tr>`

  const content = `
  ${filterBar({ filters, groups, action: "/events", showStatus: false })}
  <div class="card"><div class="table-responsive"><table class="table table-vcenter card-table table-sm">
    <thead><tr><th>时间</th><th>动作</th><th>组</th><th>来源</th><th>详情</th></tr></thead>
    <tbody>${body}</tbody></table></div></div>`
  return layout({ title: "事件流", active: "/events", content })
}

export function statsPage({ stats, rollups, groups }) {
  const roll = rollups.map((r) => `<tr><td>${esc(r.day)}</td><td class="mono">${esc(r.group_id)}</td><td>${esc(r.action)}</td><td class="num">${esc(r.n)}</td></tr>`).join("")
  const content = `
  <div class="row row-cards">
    ${statCard("已生效", stats.promoted, "")}${statCard("草稿", stats.drafts, "")}
    ${statCard("冲突", stats.conflicted, "")}${statCard("归档", stats.archived, "")}
  </div>
  <div class="card mt-3"><div class="card-header"><h3 class="card-title">历史事件汇总（rollup）</h3></div>
    <div class="table-responsive"><table class="table table-sm card-table">
      <thead><tr><th>日期</th><th>组</th><th>动作</th><th>次数</th></tr></thead>
      <tbody>${roll || "<tr><td colspan='4' class='text-secondary'>暂无汇总（事件超过 90 天后才会生成）</td></tr>"}</tbody></table></div></div>`
  return layout({ title: "统计", active: "/stats", content })
}

export function graphPage({ groups }) {
  const content = `
  <div class="d-flex gap-2 mb-3">
    <select id="group" class="form-select" style="max-width:220px">
      <option value="">全部组</option>
      ${groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("")}
    </select>
    <button class="btn btn-primary" id="reload">刷新</button>
    <span class="text-secondary small align-self-center" id="meta"></span>
  </div>
  <div id="cy" style="height:640px;border:1px solid var(--tblr-border-color,#e6e7e9);border-radius:8px;background:#fff"></div>
  <div class="card mt-3 d-none" id="detail"><div class="card-body" id="detail-body"></div></div>
  <script src="/assets/cytoscape.min.js"></script>
  <script>
    const COLORS = { memory: "#206bc4", group: "#f59f00", topic: "#2fb344", file: "#d6336c", session: "#7048e8" };
    let cy;
    async function load() {
      const g = document.getElementById("group").value;
      const res = await fetch("/api/graph" + (g ? "?group=" + encodeURIComponent(g) : ""));
      const data = await res.json();
      document.getElementById("meta").textContent = data.nodes.length + " 节点 / " + data.edges.length + " 边";
      if (cy) cy.destroy();
      cy = cytoscape({
        container: document.getElementById("cy"),
        elements: [
          ...data.nodes.map(n => ({ data: { id: n.id, label: n.label, type: n.type, group: n.group } })),
          ...data.edges.map(e => ({ data: { id: e.src + "|" + e.predicate + "|" + e.dst, source: e.src, target: e.dst, label: e.predicate } })),
        ],
        style: [
          { selector: "node", style: { label: "data(label)", "font-size": 9, width: 18, height: 18,
              "background-color": (ele) => COLORS[ele.data("type")] || "#888", color: "#333" } },
          { selector: "node[type='memory']", style: { width: 26, height: 26, "font-size": 11 } },
          { selector: "edge", style: { width: 1, "line-color": "#d0d4da", "target-arrow-color": "#d0d4da",
              "target-arrow-shape": "triangle", "curve-style": "bezier", "font-size": 7, color: "#999" } },
        ],
        layout: { name: "cose", animate: false, padding: 30 },
      });
      cy.on("tap", "node", async (evt) => {
        const id = evt.target.id();
        const box = document.getElementById("detail");
        const body = document.getElementById("detail-body");
        box.classList.remove("d-none");
        if (id.startsWith("memory:")) {
          const mid = id.slice("memory:".length);
          const r = await fetch("/api/memory/" + encodeURIComponent(mid));
          if (r.ok) {
            const m = await r.json();
            body.innerHTML = "<div class='mb-2'><strong>" + m.content + "</strong></div>" +
              "<div class='text-secondary small'>" + m.kind + " · " + m.status + " · conf " + m.confidence + "</div>" +
              "<a class='btn btn-sm btn-outline-primary mt-2' href='/memories/" + mid + "'>打开详情</a>";
          } else body.textContent = "未找到该记忆";
        } else {
          body.innerHTML = "<div class='mono small'>" + id + "</div>";
        }
      });
    }
    document.getElementById("reload").onclick = load;
    document.getElementById("group").onchange = load;
    load();
  </script>`
  return layout({ title: "图谱", active: "/graph", content })
}
