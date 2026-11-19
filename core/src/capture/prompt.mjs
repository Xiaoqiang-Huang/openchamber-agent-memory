// 提炼提示词。只记录「用户明确说过/决定过」的事实，生活类一律丢弃。
export const EXTRACTION_PROMPT = `你是记忆提取器。输入是最近一段编程/科研会话（可能含工具调用摘要）。

只提取【用户明确说过、明确决定过、明确踩过的坑】。禁止从助手的话里推断用户偏好。

输出一个 JSON 数组（最多 5 条），不要任何解释、不要 markdown 代码块：
[
  {
    "kind": "decision | pitfall | progress | reference | preference | procedure",
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
4. 同一件事只输出一次；两条候选如果讲的是同一决定/偏好，只保留信息量最大的一条。同一主题最多 2 条，宁少勿多。
5. 用户的资源/情绪/客套话本身不算记忆；只有会改变你后续做法时才归纳成一条（如"回答不必压缩 token"）。
6. 如果没有任何可提取内容，输出 []。

会话记录：
`

export function buildPrompt(transcript) {
  return EXTRACTION_PROMPT + transcript
}
