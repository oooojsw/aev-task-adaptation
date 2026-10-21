export const REVIEW_OUTPUT = 'Return your complete final review as ordinary text or Markdown, with evidence, uncertainties and recommendations. Exclude hidden reasoning, tool transcripts and compaction summaries. End with exactly one line AEV_REVIEW_CONTROL: {"ready_for_final_acceptance":false} (true only when you recommend submission). This is advice, never formal acceptance.'

export function reviewControl(text?: string) {
  if (!text) return { ready: false, status: "missing" }
  // 只读最终正文末尾的控制行，不从示例或工具轨迹猜判决。
  const match = text.trimEnd().match(/(?:^|\n)AEV_REVIEW_CONTROL:\s*(\{[^\n]*\})$/)
  try {
    const value = JSON.parse(match ? match[1] : text)
    if (typeof value.ready_for_final_acceptance !== "boolean") return { ready: false, status: "missing" }
    return { ready: value.ready_for_final_acceptance as boolean, status: "complete" }
  } catch {
    return { ready: false, status: "missing" }
  }
}
