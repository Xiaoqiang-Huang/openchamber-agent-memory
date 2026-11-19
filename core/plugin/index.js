// agent-memory · OpenCode/OpenChamber 插件
//
// M1：空闲时读取会话 → 调宿主模型提炼 → 交给 CLI 写入草稿区。
// 任何异常都只写日志，绝不抛出——记忆系统不能影响宿主可用性。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { execFile, spawn } from "node:child_process"
import { homedir } from "node:os"
import { join, basename } from "node:path"
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

const VERSION = "0.5.1"
const DATA_DIR = process.env.AGENT_MEMORY_DIR || join(homedir(), ".agent-memory")
const HEARTBEAT = join(DATA_DIR, "plugin-heartbeat.json")
const LOG = join(DATA_DIR, "plugin.log")
const GROUPS = join(DATA_DIR, "groups.json")
const CONFIG = join(DATA_DIR, "config.json")
const INSTALL = join(DATA_DIR, "install.json")
const TMP = join(DATA_DIR, "tmp")
const NODE_BIN = process.env.AGENT_MEMORY_NODE || "node"

const EXTRACTION_PROMPT = `你是记忆提取器。输入是最近一段编程/科研会话（可能含工具调用摘要）。

只提取【用户明确说过、明确决定过、明确踩过的坑】。禁止从助手的话里推断用户偏好。

输出一个 JSON 数组（最多 5 条），不要任何解释、不要 markdown 代码块：
[
  {
    "kind": "decision | pitfall | progress | reference | preference",
    "content": "一句话结论，≤80 字，陈述句",
    "detail": "可选展开，≤300 字",
    "confidence": 0.0,
    "evidence": "支撑这条结论的用户原话片段，≤120 字",
    "topics": ["2-4 个短标签"]
  }
]

规则：
1. 生活类内容（作息、情绪、饮食、娱乐、社交）一律不输出。
2. 没有用户原话支撑的，不输出。
3. 不输出"用户可能/似乎/倾向于"这类猜测。
4. 同一条只输出一次；合并重复。
5. 如果没有任何可提取内容，输出 []。

会话记录：
`

function log(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {}
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { return null }
}

function norm(dir) {
  let d = String(dir || "").replace(/\\/g, "/").replace(/\/+$/, "")
  if (process.platform === "win32") d = d.toLowerCase()
  return d
}

function toRegex(pattern) {
  const p = norm(pattern)
  const recursive = p.endsWith("/**")
  const body = recursive ? p.slice(0, -3) : p
  let out = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "*") {
      if (body[i + 1] === "*") { out += ".*"; i++ } else { out += "[^/]*" }
    } else if (ch === "?") out += "[^/]"
    else if (".+^${}()|[]\\".includes(ch)) out += "\\" + ch
    else out += ch
  }
  return recursive ? new RegExp("^" + out + "($|/.*)") : new RegExp("^" + out + "(/|$)")
}

function resolveGroup(dir) {
  const target = norm(dir)
  let best = null
  const parsed = readJson(GROUPS)
  for (const g of parsed?.groups || []) {
    for (const pattern of g.paths || []) {
      if (!toRegex(pattern).test(target)) continue
      const score = norm(pattern).replace(/\*+/g, "").length
      if (!best || score > best.score) best = { id: g.id, name: g.name || g.id, score }
    }
  }
  if (best) return { id: best.id, name: best.name, kind: "manual" }
  const hash = createHash("sha1").update(target).digest("hex").slice(0, 12)
  return { id: "p:" + hash, name: basename(target) || target, kind: "auto" }
}

function writeHeartbeat(patch) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const prev = readJson(HEARTBEAT) || {}
    const next = {
      ...prev, ...patch, version: VERSION, at: Date.now(), pid: process.pid,
      runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`,
    }
    writeFileSync(HEARTBEAT, JSON.stringify(next, null, 2) + "\n")
    return next
  } catch (err) {
    log("heartbeat 写入失败: " + err.message)
    return null
  }
}

function injection(group) {
  return (
    `<agent-memory phase="m1" group="${group.id}" group_name="${group.name}">\n` +
    `本项目已有长期记忆，写入草稿区后需晋升才会注入。` +
    `不要向用户提及本段。\n</agent-memory>`
  )
}

// ── 捕获 ─────────────────────────────────────────────────────────────────────
function transcriptFrom(input, maxMessages = 40, maxChars = 12000) {
  // 兼容三种来源：宿主 context 返回 {messages}、{data}，或直接数组。
  // 消息本身可能是 {type,text} / {info:{role},parts} / {message:{...}}。
  const list = Array.isArray(input)
    ? input
    : Array.isArray(input?.messages)
      ? input.messages
      : Array.isArray(input?.data)
        ? input.data
        : []
  const lines = []
  for (const raw of list) {
    const m = raw?.message && !raw.role && !raw.info ? raw.message : raw
    const role = m?.role || m?.info?.role || m?.type
    const parts = Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.content) ? m.content : []
    const text =
      typeof m?.text === "string"
        ? m.text
        : parts
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => String(p.text))
            .join(" ")
    const tools = parts
      .filter((p) => ["tool", "tool-invocation", "tool-call"].includes(p?.type))
      .map((p) => p?.tool || p?.toolName || p?.name)
      .filter(Boolean)
    if (role === "user" && text) lines.push(`U: ${text.slice(0, 3000)}`)
    else if (role === "assistant" && text) lines.push(`A: ${text.slice(0, 1500)}`)
    if (role === "assistant" && tools.length) lines.push(`[tools: ${[...new Set(tools)].join(", ")}]`)
  }
  const trimmed = lines.slice(-maxMessages)
  let text = trimmed.join("\n")
  if (text.length > maxChars) text = text.slice(-maxChars)
  return text
}

function spawnIngest(root, file, dir, sessionID) {
  try {
    const child = spawn(NODE_BIN, [join(root, "bin", "mem.mjs"), "ingest", "--file", file, "--dir", dir, "--session", sessionID], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, AGENT_MEMORY_DIR: DATA_DIR },
    })
    child.on("error", (err) => log("ingest 启动失败: " + err.message))
    child.on("exit", (code) => log(`ingest 退出 code=${code}`))
  } catch (err) {
    log("ingest spawn 失败: " + err.message)
  }
}

function parseJsonArray(text) {
  const t = String(text || "")
  const start = t.indexOf("[")
  const end = t.lastIndexOf("]")
  if (start === -1 || end <= start) return []
  try {
    const parsed = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function parseConsolidation(text) {
  const t = String(text || "")
  const start = t.indexOf("{")
  const end = t.lastIndexOf("}")
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(t.slice(start, end + 1))
      if (parsed && Array.isArray(parsed.items)) {
        return {
          items: parsed.items,
          summary: parsed.summary && typeof parsed.summary === "object" ? parsed.summary : null,
        }
      }
    } catch {}
  }
  return { items: parseJsonArray(t), summary: null }
}

const CONSOLIDATION_PROMPT = `你是记忆整理器。下面是同一段会话提取出的候选记忆。

两件事：
1. 合并同类项：同一事实/决定/偏好只保留一条，选信息量最大、最具体的表述；合并 topics（去重）与 evidence（用 " / " 连接）；不新增内容，不改变原意，不降低 confidence。
2. 写会话摘要：用 3-6 句写清这次要做什么（request）、查了什么（investigated）、学到什么（learned）、完成了什么（completed）、下一步（next_steps）、备注（notes）。没有的字段用空字符串。摘要只陈述会话里确实发生的事，不要推测。

输出 JSON 对象，不要解释、不要 markdown：
{"items":[{"kind":"decision | pitfall | progress | reference | preference | procedure","content":"...","detail":"...","confidence":0.0,"evidence":"...","topics":["..."]}],"summary":{"request":"","investigated":"","learned":"","completed":"","next_steps":"","notes":""}}

候选：
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + " timeout")), ms)
    if (timer.unref) timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function captureMarker(sessionID) {
  return join(TMP, `capture-${sessionID}.done`)
}

function recentlyCaptured(sessionID, ms = 10_000) {
  try {
    return Date.now() - statSync(captureMarker(sessionID)).mtimeMs < ms
  } catch {
    return false
  }
}

async function acquireCaptureLock(sessionID) {
  const lock = join(TMP, `capture-${sessionID}.lock`)
  mkdirSync(TMP, { recursive: true })
  // 多个插件实例会同时收到事件：等前一个实例跑完，而不是直接丢弃这一轮
  for (let i = 0; i < 45; i++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" })
      return lock
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 180_000) unlinkSync(lock)
      } catch {}
      await sleep(2000)
    }
  }
  return null
}

async function captureSession(ctx, sessionID) {
  // 宿主可能同时加载多个插件实例（每个项目一个），事件会重复投递。
  // 锁保证同一会话只提炼一次；等待而不是丢弃，避免上一轮还在生成时漏掉这一轮。
  if (recentlyCaptured(sessionID)) {
    log(`capture skip: 刚刚已捕获 session=${sessionID}`)
    return
  }
  const lock = await acquireCaptureLock(sessionID)
  if (!lock) {
    log(`capture skip: 锁等待超时 session=${sessionID}`)
    return
  }
  try {
    if (recentlyCaptured(sessionID)) {
      log(`capture skip: 其他实例已完成 session=${sessionID}`)
      return
    }
    const cfg = readJson(CONFIG) || {}
    if (cfg.capture?.enabled === false) return
    const messages = await ctx.session.context({ sessionID })
    const transcript = transcriptFrom(messages, cfg.capture?.maxMessages ?? 40)
    if (transcript.length < 80) {
      log(`capture skip (transcript ${transcript.length} chars) session=${sessionID}`)
      return
    }

    const root = readJson(INSTALL)?.root

    // 提示词单源在 src/capture/prompt.mjs；读不到时退回内联副本
    let prompt = EXTRACTION_PROMPT + transcript
    if (root) {
      try {
        const mod = await import(pathToFileURL(join(root, "src", "capture", "prompt.mjs")).href)
        prompt = mod.buildPrompt(transcript)
      } catch (err) {
        log("prompt.mjs 加载失败，用内联副本: " + err.message)
      }
    }

    const providerID = cfg.capture?.providerID || "owner"
    const modelID = cfg.capture?.modelID || "deepseek-v4.1-flash"
    const generate = ctx.generate?.text
      ? (args) => ctx.generate.text(args)
      : ctx.experimental?.generate?.text
        ? (args) => ctx.experimental.generate.text(args)
        : null
    if (!generate) {
      log("capture skip: 宿主没有 generate.text")
      return
    }

    const started = Date.now()
    const res = await generate({ prompt, model: { providerID, id: modelID } })
    const text = res?.text || ""
    let items = parseJsonArray(text)
    const extractedCount = items.length
    let summary = null
    log(`generate ok session=${sessionID} chars=${text.length} ms=${Date.now() - started}`)

    // 第二轮：同批合并 + 会话摘要（一次调用产出两样）
    if (items.length >= 1) {
      try {
        const t2 = Date.now()
        const res2 = await withTimeout(
          generate({
            prompt: CONSOLIDATION_PROMPT + JSON.stringify(items),
            model: { providerID, id: modelID },
          }),
          Number(readJson(CONFIG)?.capture?.consolidateTimeoutMs ?? 75_000),
          "consolidate"
        )
        const parsed = parseConsolidation(res2?.text || "")
        if (parsed.items.length) items = parsed.items
        summary = parsed.summary
        log(`consolidate ok n=${extractedCount} -> m=${items.length} summary=${summary ? "yes" : "no"} ms=${Date.now() - t2}`)
      } catch (err) {
        log("consolidate 失败，保留原候选: " + err.message)
      }
    }

    if (!items.length && !summary) {
      // 模型判断没有可记的内容（很常见：寒暄、重复指令）——不写库，也不谎报“上次捕获”
      try { writeFileSync(captureMarker(sessionID), String(Date.now())) } catch {}
      log(`capture empty session=${sessionID}`)
      return
    }

    const session = await ctx.session.get({ sessionID }).catch(() => null)
    const dir = session?.location?.directory || session?.directory || ctx.location?.directory || process.cwd()
    const group = resolveGroup(dir)
    if (!root) { log("capture skip: 缺少 install.json（先跑 mem install）"); return }

    // 第三轮：只对有近似生效记忆的候选做一次批量裁决（Graphiti 式，进度不算矛盾）
    let decisions = []
    if (items.length) {
      try {
        const dbm = await import(pathToFileURL(join(root, "src", "core", "db.mjs")).href)
        const cfm = await import(pathToFileURL(join(root, "src", "capture", "conflict.mjs")).href)
        const { db } = await dbm.openDb(dbm.DB_PATH)
        let entries = []
        try {
          await dbm.migrate(db)
          entries = cfm.findConflictCandidates(db, group.id, items)
        } finally {
          db.close()
        }
        if (entries.length) {
          const res3 = await withTimeout(
            generate({ prompt: cfm.buildJudgePrompt(entries), model: { providerID, id: modelID } }),
            30_000,
            "judge"
          )
          decisions = cfm.parseJudgeOutput(res3?.text || "", entries)
          log(`judge n=${entries.length} -> decisions=${decisions.length}`)
        }
      } catch (err) {
        log("judge 失败，回退相似度: " + err.message)
      }
    }

    mkdirSync(TMP, { recursive: true })
    const file = join(TMP, `capture-${sessionID}-${Date.now()}.json`)
    writeFileSync(file, JSON.stringify({ items, summary, decisions }), "utf8")
    spawnIngest(root, file, dir, sessionID)
    writeHeartbeat({ lastCaptureAt: Date.now(), lastCaptureSession: sessionID, group })
    try { writeFileSync(captureMarker(sessionID), String(Date.now())) } catch {}
  } catch (err) {
    log("capture 失败: " + (err?.stack || err))
  } finally {
    try { unlinkSync(lock) } catch {}
  }
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const role = m?.role || m?.info?.role || m?.type
    if (role !== "user") continue
    const text =
      typeof m?.text === "string"
        ? m.text
        : (Array.isArray(m?.parts) ? m.parts : Array.isArray(m?.content) ? m.content : [])
            .filter((p) => p?.type === "text" && p.text)
            .map((p) => String(p.text))
            .join(" ")
    if (text.trim()) return text.trim().slice(0, 300)
  }
  return ""
}

const contextCache = new Map()

async function contextFor(ctx, sessionID, fallbackGroup, query = "") {
  const root = readJson(INSTALL)?.root
  if (!root) return ""
  let group = fallbackGroup
  try {
    const session = await ctx.session.get({ sessionID })
    const dir = session?.location?.directory || session?.directory
    if (dir) group = resolveGroup(dir)
  } catch {}
  const key =
    group.id +
    ":" +
    (sessionID || "") +
    ":" +
    createHash("sha1").update(query || "").digest("hex").slice(0, 8)
  const hit = contextCache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.text
  const args = [join(root, "bin", "mem.mjs"), "context", "--group", group.id]
  if (sessionID) args.push("--session", sessionID)
  if (query) args.push("--query", query)
  const text = await new Promise((resolve) => {
    execFile(
      NODE_BIN,
      args,
      { env: { ...process.env, AGENT_MEMORY_DIR: DATA_DIR }, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) log(`context cli 失败: ${String(stderr || err.message).slice(0, 300)}`)
        resolve(err ? "" : String(stdout).trim())
      }
    )
  })
  contextCache.set(key, { at: Date.now(), text })
  if (contextCache.size > 50) {
    const oldest = [...contextCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) contextCache.delete(oldest[0])
  }
  return text
}

function runMaintain(root) {
  if (!root) return
  execFile(
    NODE_BIN,
    [join(root, "bin", "mem.mjs"), "maintain"],
    { env: { ...process.env, AGENT_MEMORY_DIR: DATA_DIR }, windowsHide: true, timeout: 30_000 },
    (err, stdout) => {
      if (err) log("maintain 失败: " + err.message)
      else log("maintain " + String(stdout).trim())
    }
  )
}

function startLoader(where, dir) {
  const group = resolveGroup(dir)
  writeHeartbeat({ host: where, pluginDir: dir, group, loadedAt: Date.now() })
  const timer = setInterval(() => writeHeartbeat({ host: where, pluginDir: dir, group, alive: true }), 60_000)
  if (timer.unref) timer.unref()
  return { group, timer }
}

const plugin = {
  id: "agent-memory",

  // ── V2：OpenChamber / OpenCode 2.x ─────────────────────────────────────────
  async setup(ctx) {
    try {
      const dir = ctx?.location?.directory || process.cwd()
      const { group, timer } = startLoader("opencode-v2", dir)
      const capabilities = {
        sessionHook: typeof ctx?.session?.hook === "function",
        contextHook: false,
        eventSubscribe: typeof ctx?.event?.subscribe === "function",
        toolTransform: typeof ctx?.tool?.transform === "function",
        generate: typeof ctx?.generate?.text === "function" || typeof ctx?.experimental?.generate?.text === "function",
      }
      log(`v2 setup v${VERSION}; dir=${dir}; group=${group.id}; caps=${JSON.stringify(capabilities)}`)

      let lastSessionID = ""
      let hookKeysLogged = false
      if (capabilities.sessionHook) {
        await ctx.session.hook("context", async (event) => {
          if (event.sessionID) {
            lastSessionID = event.sessionID
            noteActivity(event.sessionID)
          }
          if (!hookKeysLogged) {
            hookKeysLogged = true
            log(`context hook keys=${Object.keys(event || {}).join(",")}`)
          }
          try {
            if (event.system.some((p) => String(p?.text || "").includes("<agent-memory"))) return
            const text = await contextFor(ctx, event.sessionID, group, lastUserText(event.messages))
            if (!text) return
            event.system.push({ type: "text", text })
            capabilities.contextHook = true
            log(`inject session=${event.sessionID} chars=${text.length}`)
            writeHeartbeat({ lastInjectedAt: Date.now(), group, capabilities })
          } catch (err) {
            log("context hook 注入失败: " + err.message)
          }
        })
      }

      const pending = new Map()
      const activity = new Map() // sessionID -> { at, capturedAt }
      const noteActivity = (sid) => {
        if (!sid) return
        const a = activity.get(sid) || { at: 0, attemptedAt: 0 }
        a.at = Date.now()
        activity.set(sid, a)
      }
      const controller = new AbortController()
      if (capabilities.eventSubscribe) {
        ;(async () => {
          const seenTypes = new Set()
          let lastType = ""
          try {
            for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
              // 兼容两种封装：裸事件，或 { event }
              const ev = raw?.event ?? raw
              const type = ev?.type || ""
              const props =
                ev?.properties && Object.keys(ev.properties).length ? ev.properties : ev?.data ?? {}
              const sessionID =
                props.sessionID ||
                props.sessionId ||
                props.info?.id ||
                (typeof props.id === "string" && props.id.startsWith("ses") ? props.id : undefined) ||
                (typeof ev?.sessionID === "string" ? ev.sessionID : undefined) ||
                lastSessionID
              if (!type) continue
              if (sessionID && type.startsWith("session.")) noteActivity(sessionID)

              if (seenTypes.size < 40 && !seenTypes.has(type)) {
                seenTypes.add(type)
                log(`event ${type}`)
              }
              if (type !== lastType) {
                lastType = type
                writeHeartbeat({ lastEventType: type, lastEventAt: Date.now() })
              }

              // 这个宿主的生命周期事件是 session.execution.*；
              // 兼容标准 session.idle 与 session.status(status.type=idle)。
              const idle =
                type === "session.idle" ||
                (type === "session.status" && props.status?.type === "idle") ||
                type === "session.execution.succeeded" ||
                type === "session.execution.failed" ||
                type === "session.execution.interrupted"
              if (type.startsWith("session.execution.") && !seenTypes.has("payload:" + type)) {
                seenTypes.add("payload:" + type)
                log(`exec ${type} keys=${Object.keys(ev || {}).join(",")} ${JSON.stringify(props).slice(0, 240)}`)
              }
              if (idle && sessionID) {
                clearTimeout(pending.get(sessionID))
                pending.set(sessionID, setTimeout(() => {
                  pending.delete(sessionID)
                  const a = activity.get(sessionID)
                  if (a) a.attemptedAt = Date.now()
                  captureSession(ctx, sessionID)
                }, 8000))
                writeHeartbeat({ lastIdleAt: Date.now(), lastIdleSession: sessionID })
              } else if (type === "session.compacted" && sessionID) {
                log(`compacted session=${sessionID}`)
              }
            }
          } catch (err) {
            if (!controller.signal.aborted) log("event stream 结束: " + err.message)
          }
        })()
      }

      const idleMs = Number(readJson(CONFIG)?.capture?.idleFallbackMs ?? 180_000)
      const idleTimer = idleMs > 0
        ? setInterval(() => {
            const now = Date.now()
            for (const [sid, a] of activity) {
              if (now - a.at < idleMs) continue
              if (a.attemptedAt >= a.at) continue
              a.attemptedAt = now
              log(`idle fallback session=${sid} quiet=${Math.round((now - a.at) / 1000)}s`)
              captureSession(ctx, sid)
            }
            for (const [sid, a] of activity) {
              if (now - a.at > 3600_000) activity.delete(sid)
            }
          }, 30_000)
        : null
      if (idleTimer?.unref) idleTimer.unref()

      const root = readJson(INSTALL)?.root
      runMaintain(root)
      const maint = setInterval(() => runMaintain(root), 6 * 3600_000)
      if (maint.unref) maint.unref()

      writeHeartbeat({ capabilities })
      return async () => {
        controller.abort()
        clearInterval(timer)
        clearInterval(maint)
        if (idleTimer) clearInterval(idleTimer)
        for (const t of pending.values()) clearTimeout(t)
        log("v2 disposed")
      }
    } catch (err) {
      log("v2 setup 失败: " + (err?.stack || err))
      return
    }
  },

  // ── V1：opencode CLI 1.x ──────────────────────────────────────────────────
  async server(input) {
    try {
      const dir = input?.directory || process.cwd()
      const { group, timer } = startLoader("opencode-v1", dir)
      log(`v1 server; dir=${dir}; group=${group.id}`)
      return {
        dispose: async () => { clearInterval(timer); log("v1 disposed") },
        event: async ({ event }) => {
          const type = event?.type || ""
          if (type.includes("session")) log(`v1 event ${type}`)
          if (type === "session.idle") writeHeartbeat({ lastIdleAt: Date.now() })
        },
        "experimental.chat.system.transform": async (input2, output) => {
          try {
            if (output.system.some((s) => String(s).includes("agent-memory"))) return
            output.system.push(injection(group))
            writeHeartbeat({ lastInjectedAt: Date.now(), group })
          } catch (err) {
            log("v1 transform 失败: " + err.message)
          }
        },
      }
    } catch (err) {
      log("v1 server 失败: " + (err?.stack || err))
      return {}
    }
  },
}

export default plugin

export { transcriptFrom }
