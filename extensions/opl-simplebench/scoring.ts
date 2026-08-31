export function normalizeAnswer(value: string): string {
  return value.trim().replace(/[.!?]+$/, "").trim().toLowerCase();
}

export function extractAnswer(response: string): { answer: string; method: string } {
  const line = response.trimEnd().split("\n").map(line => line.trim()).filter(Boolean).at(-1);
  return line ? { answer: normalizeAnswer(line), method: "final-line" } : { answer: "?", method: "none" };
}

export function scoreReasoning(response: string, expected: string) {
  const extracted = extractAnswer(response);
  const correct = extracted.answer === normalizeAnswer(expected);
  return {
    answer: extracted.answer,
    extractionMethod: extracted.method,
    matchedWords: [],
    score: correct ? "STRONG" : "FAIL",
    pass: correct,
  };
}

export function averageScore(scores: string[]): string {
  const weights: Record<string, number> = { STRONG: 3, MODERATE: 2, WEAK: 1, FAIL: 0, ERROR: 0 };
  const average = scores.reduce((sum, score) => sum + (weights[score] || 0), 0) / scores.length;
  if (average >= 2.5) return "STRONG";
  if (average >= 1.5) return "MODERATE";
  if (average >= 0.5) return "WEAK";
  return "FAIL";
}
