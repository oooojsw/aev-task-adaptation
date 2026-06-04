import { hasConcreteAnswerLeakageSurface } from "../orchestrator/answer-surface"

const blocked = [
  "Confirmed from spec.json validators that expected answer is 2,602 (in millions of dollars)",
  "The final answer is 12345.",
  "The required 1940 value (2,602 millions) is identified.",
  "answer: 88.2%",
]

const allowed = [
  "Use PDF page 15 and table 3 to locate the relevant Treasury Bulletin row.",
  "Round to 2 decimal places only after recomputing from source evidence.",
  "Search the document page labels because PDF page 15 can differ from viewer index 16.",
  "Use tolerance 0.01 only for validator comparison, not as a stored answer.",
]

for (const item of blocked) {
  if (!hasConcreteAnswerLeakageSurface(item)) throw new Error(`Expected blocked answer surface: ${item}`)
}

for (const item of allowed) {
  if (hasConcreteAnswerLeakageSurface(item)) throw new Error(`Expected allowed operational memory: ${item}`)
}

console.log("smoke-answer-surface-memory-filter: PASS")
