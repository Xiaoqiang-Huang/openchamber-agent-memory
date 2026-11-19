import { chromium } from "playwright"

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe"
const base = "http://127.0.0.1:8099/preview.html?preview=1"
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 390, height: 880 }, deviceScaleFactor: 2 })
await page.goto(base, { waitUntil: "networkidle" })
await page.waitForTimeout(500)
await page.click('[data-nav="graph"]')
await page.waitForTimeout(1400)
await page.screenshot({ path: "shots/04-graph.png", fullPage: true })

const nodePoint = async (id) =>
  page.evaluate((id) => {
    const cy = window.__amcy
    const n = cy.getElementById(id)
    const r = cy.container().getBoundingClientRect()
    const p = n.renderedPosition()
    return { x: r.left + p.x, y: r.top + p.y }
  }, id)

const clickNode = async (id) => {
  const p = await nodePoint(id)
  await page.mouse.click(p.x, p.y)
  await page.waitForTimeout(350)
}

await clickNode("memory:m1")
await page.screenshot({ path: "shots/04b-graph-select.png", fullPage: true })

await page.click("#gi-act") // 打开详情
await page.waitForTimeout(500)
await page.screenshot({ path: "shots/04c-graph-detail.png", fullPage: false })
await page.keyboard.press("Escape")
await page.waitForTimeout(300)

// 邻居视图
await clickNode("topic:agent-memory")
await page.waitForTimeout(250)
await page.click("#gi-act")
await page.waitForTimeout(700)
await page.screenshot({ path: "shots/04d-graph-focus.png", fullPage: true })

// 搜索
await page.fill("#gsearch", "目录")
await page.waitForTimeout(400)
await page.screenshot({ path: "shots/04e-graph-search.png", fullPage: true })

// 布局切换（先退出邻居视图）
await page.fill("#gsearch", "")
await page.click("#greset")
await page.waitForTimeout(500)
await page.selectOption("#glayout", "concentric")
await page.waitForTimeout(900)
await page.screenshot({ path: "shots/04f-graph-concentric.png", fullPage: true })

// 图例开关
await page.click('.legend-chip[data-type="session"]')
await page.waitForTimeout(700)
await page.screenshot({ path: "shots/04g-graph-legend.png", fullPage: true })
await page.click('.legend-chip[data-type="session"]')

// 空组
await page.selectOption("#ggroup", "paper")
await page.waitForTimeout(900)
await page.screenshot({ path: "shots/04h-graph-empty.png", fullPage: true })

// 全屏
await page.selectOption("#ggroup", "")
await page.waitForTimeout(900)
await page.click("#gfull")
await page.waitForTimeout(700)
await page.screenshot({ path: "shots/04i-graph-full.png", fullPage: false })
await page.click("#gfull")

// 导出 PNG
const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null)
await page.click("#gexport")
const d = await dl
console.log("export:", d ? d.suggestedFilename() : "no download")
if (d) await d.saveAs("shots/export-check.png")

await browser.close()
console.log("graph shots done")
