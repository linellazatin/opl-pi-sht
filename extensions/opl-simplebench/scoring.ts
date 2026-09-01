export function normalizeAnswer(value: string): string {
  return value.trim().replace(/[.!?]+$/, "").trim().toLowerCase();
}

const NUMERIC_ANSWER = /^\d+$/;

function lastNumericToken(line: string): string | null {
  const tokens = line.match(/\d+/g);
  return tokens && tokens.length ? tokens[tokens.length - 1] : null;
}

export function extractAnswer(response: string, expected?: string): { answer: string; method: string } {
  const lines = response.trimEnd().split("\n").map(line => line.trim()).filter(Boolean);
  // Numeric contracts: scan backward for a line whose last numeric token is the
  // expected value. This accepts naked "8" / "8 days" answers and skips trailing
  // bare-number remnants that thinking templates leak after the real final line.
  if (expected && NUMERIC_ANSWER.test(expected)) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const token = lastNumericToken(lines[i]);
      if (token === expected) {
        return { answer: token, method: i === lines.length - 1 ? "final-line" : "expected-last-numeric" };
      }
    }
  }
  const line = lines.at(-1);
  return line ? { answer: normalizeAnswer(line), method: "final-line" } : { answer: "?", method: "none" };
}

export function scoreReasoning(response: string, expected: string) {
  const extracted = extractAnswer(response, expected);
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
