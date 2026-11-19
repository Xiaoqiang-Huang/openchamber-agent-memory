// agent-memory extension service：把面板请求转成 `mem api` 调用。
// 只依赖 Node 内置模块；记忆逻辑单源在 agent-memory 仓库里。
import http from "node:http"
import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? ""
const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0)
const DATA = process.env.AGENT_MEMORY_DIR || join(homedir(), ".agent-memory")
const HERE = dirname(fileURLToPath(import.meta.url))

// 优先用扩展包内自带的记忆内核（core/），不再依赖本机的 install.json。
function memBin(): string {
  const override = process.env.AGENT_MEMORY_BIN
  if (override) return override
  const local = join(HERE, "..", "core", "bin", "mem.mjs")
  if (existsSync(local)) return local
  const install = JSON.parse(readFileSync(join(DATA, "install.json"), "utf8")) as { root: string }
  return join(install.root, "bin", "mem.mjs")
}

function mem(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [memBin(), "api", ...args],
      { env: { ...process.env, AGENT_MEMORY_DIR: DATA }, windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim()))
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(parseErr)
        }
      }
    )
  })
}

function send(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data ?? {})
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

const server = http.createServer((req, res) => {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end()
    return
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  const path = url.pathname

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end("{}")
    return
  }

  let raw = ""
  req.on("data", (chunk) => {
    raw += chunk
    if (raw.length > 1_000_000) req.destroy()
  })
  req.on("end", () => {
    let body: any = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }

    const run = async (): Promise<unknown> => {
      switch (path) {
        case "/status":
          return await mem(["status"])

        case "/list": {
          const args = ["list", "--limit", url.searchParams.get("limit") ?? "50"]
          const status = url.searchParams.get("status")
          const group = url.searchParams.get("group")
          const q = url.searchParams.get("q")
          const kind = url.searchParams.get("kind")
          const sort = url.searchParams.get("sort")
          const offset = url.searchParams.get("offset")
          if (status) args.push("--status", status)
          if (group) args.push("--group", group)
          if (q) args.push("--query", q)
          if (kind) args.push("--kind", kind)
          if (sort) args.push("--sort", sort)
          if (offset) args.push("--offset", offset)
          return await mem(args)
        }

        case "/memory":
          return await mem(["memory", String(url.searchParams.get("id") ?? "")])

        case "/events": {
          const args = ["events", "--limit", url.searchParams.get("limit") ?? "200"]
          const group = url.searchParams.get("group")
          if (group) args.push("--group", group)
          return await mem(args)
        }

        case "/stats":
          return await mem(["stats"])

        case "/graph": {
          const args = ["graph"]
          const group = url.searchParams.get("group")
          if (group) args.push("--group", group)
          return await mem(args)
        }

        case "/state": {
          const args = ["state", "--group", String(url.searchParams.get("group") ?? "")]
          const session = url.searchParams.get("session")
          if (session) args.push("--session", session)
          return await mem(args)
        }

        case "/state-set": {
          if (!body.group || !body.key) throw new Error("group and key are required")
          const args = [
            "state-set",
            "--group", String(body.group),
            "--key", String(body.key),
            "--value", String(body.value ?? ""),
          ]
          if (body.session) args.push("--session", String(body.session))
          return await mem(args)
        }

        case "/state-clear": {
          if (!body.group || !body.key) throw new Error("group and key are required")
          const args = ["state-clear", "--group", String(body.group), "--key", String(body.key)]
          if (body.session) args.push("--session", String(body.session))
          return await mem(args)
        }

        case "/conflicts":
          return await mem(["conflicts"])

        case "/related":
          return await mem(["related", String(url.searchParams.get("id") ?? "")])

        case "/backup":
          return await mem(["backup"])

        case "/groups":
          return await mem(["groups"])

        case "/group-save": {
          if (!body.id) throw new Error("id is required")
          return await mem([
            "group-save",
            "--id", String(body.id),
            "--name", String(body.name ?? ""),
            "--paths", (body.paths ?? []).join("|"),
          ])
        }

        case "/action":
          if (!body.action || !body.id) throw new Error("action and id are required")
          return await mem(["action", String(body.action), String(body.id)])

        case "/resolve":
          if (!body.keep || !body.drop) throw new Error("keep and drop are required")
          return await mem(["resolve", String(body.keep), String(body.drop)])

        case "/edit": {
          if (!body.id) throw new Error("id is required")
          const args = ["edit", String(body.id), "--content", String(body.content ?? "")]
          if (body.detail !== undefined) args.push("--detail", String(body.detail))
          return await mem(args)
        }

        case "/maintain":
          return await mem(["maintain"])

        default:
          return null
      }
    }

    run().then(
      (answer) => (answer === null ? send(res, 404, { error: "not found" }) : send(res, 200, answer)),
      (err) => send(res, 500, { error: String(err.message ?? err) })
    )
  })
})

server.listen(PORT, "127.0.0.1")
