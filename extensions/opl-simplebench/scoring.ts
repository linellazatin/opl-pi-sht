export const reasoningWords = ["because", "therefore", "since", "step", "subtract", "minus", "sequence", "pattern", "clockwise", "counter", "facing", "mammal", "grow", "apple", "wet", "grass", "plant", "water", "glove", "boot", "metal", "bowling", "tennis"];

function containsAnswer(response: string, answer: string): boolean {
  const escaped = answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(response);
}

export function extractAnswer(response: string, expected: string | string[]): { answer: string; method: string } {
  const allowed = Array.isArray(expected) ? expected : [expected];
  const normalized = response.toLowerCase();
  const match = allowed.find(answer => containsAnswer(normalized, answer));
  if (match) return { answer: match, method: "expected-substring" };
  if (allowed.every(a => /^\d+$/.test(a))) {
    const numbers = response.match(/\b\d+\b/g);
    return { answer: numbers?.at(-1) ?? "?", method: "last-number" };
  }
  return { answer: "?", method: "none" };
}

export function scoreReasoning(response: string, expected: string | string[]) {
  const extracted = extractAnswer(response, expected);
  const allowed = Array.isArray(expected) ? expected : [expected];
  const correct = allowed.includes(extracted.answer);
  const matchedWords = reasoningWords.filter(word => response.toLowerCase().includes(word));
  const reasoned = matchedWords.length > 0 || /^\s*\d+\.\s/m.test(response);
  return { answer: extracted.answer, extractionMethod: extracted.method, matchedWords, score: correct && reasoned ? "STRONG" : correct ? "MODERATE" : reasoned ? "WEAK" : "FAIL", pass: correct };
}

export function averageScore(scores: string[]): string {
  const weights: Record<string, number> = { STRONG: 3, MODERATE: 2, WEAK: 1, FAIL: 0, ERROR: 0 };
  const average = scores.reduce((sum, score) => sum + (weights[score] || 0), 0) / scores.length;
  if (average >= 2.5) return "STRONG";
  if (average >= 1.5) return "MODERATE";
  if (average >= 0.5) return "WEAK";
  return "FAIL";
}
