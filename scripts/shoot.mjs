import { chromium } from "playwright"
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe"
const base = "http://127.0.0.1:8099/preview.html?preview=1"
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 390, height: 880 }, deviceScaleFactor: 2 })
await page.goto(base, { waitUntil: "networkidle" })
await page.waitForTimeout(500)
await page.screenshot({ path: "shots/01-overview.png", fullPage: true })
for (const [key, file] of [["drafts","02-drafts"],["memories","03-memories"],["graph","04-graph"],["groups","05-groups"],["events","06-events"]]) {
  await page.click(`[data-nav="${key}"]`)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `shots/${file}.png`, fullPage: true })
}
await page.click(`[data-nav="drafts"]`)
await page.waitForTimeout(300)
await page.click(".item .content")
await page.waitForTimeout(400)
await page.screenshot({ path: "shots/07-detail.png", fullPage: false })
// 320 窄屏检查
const narrow = await browser.newPage({ viewport: { width: 320, height: 760 }, deviceScaleFactor: 2 })
await narrow.goto(base, { waitUntil: "networkidle" })
await narrow.waitForTimeout(400)
console.log("320 overflow:", await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
await narrow.screenshot({ path: "shots/08-320.png", fullPage: false })
await narrow.click('[data-nav="memories"]')
await narrow.waitForTimeout(400)
await narrow.screenshot({ path: "shots/09-320-memories.png", fullPage: false })

// 暗色
const dark = await browser.newPage({ viewport: { width: 390, height: 880 }, deviceScaleFactor: 2 })
await dark.goto(base + "&dark=1", { waitUntil: "networkidle" })
await dark.waitForTimeout(400)
await dark.screenshot({ path: "shots/10-dark.png", fullPage: true })

await browser.close()
console.log("done")
