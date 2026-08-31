import { fail, info, ok, section, warn, msHuman } from "./util/format";

export const branding = "  ⚡ OPL Simplebench";

export function formatInstructionScore(instructions: { pass: boolean; score: string; schemaValid: boolean }): string {
  const message = `Instruction following: ${instructions.score} (schema ${instructions.schemaValid ? "valid" : "invalid"})`;
  return instructions.pass ? ok(message) : fail(message);
}

export function formatTestSummary(tests: Array<{ name: string; pass: boolean; score: string }>, totalMs: number): string[] {
  return [section("SUMMARY"), ...tests.map(t => t.pass ? ok(`${t.name}: ${t.score}`) : fail(`${t.name}: ${t.score}`)), info(`Total time: ${msHuman(totalMs)}`), info(`Score: ${tests.filter(t => t.pass).length}/${tests.length} tests passed`)];
}
/** Legacy-compatible category recommendation. New runner uses recommendation() above. */
export function formatRecommendation(model: string, passed: number, total: number): string[] {
  const label = passed === total ? "STRONG" : passed >= total - 1 ? "GOOD" : passed >= total - 2 ? "USABLE" : "WEAK";
  return [section("RECOMMENDATION"), label === "WEAK" ? fail(`${model} is ${label}`) : ok(`${model} is ${label}`)];
}

export function recommendation(reasoning: string, instructionsPass: boolean, toolsPass: boolean, coding?: { passed: number; total: number; efficiency?: { strong: number; moderate: number; weak: number; fail: number } }) {
  const reasoningPass = reasoning === "STRONG" || reasoning === "MODERATE";
  // Efficiency-weighted coding pass: STRONG=1.0, MODERATE=0.7, WEAK=0.4, FAIL=0
  const codingPass = coding ? (() => {
    if (!coding.efficiency) return coding.passed >= Math.ceil(coding.total / 2);
    const weighted = coding.efficiency.strong * 1.0 + coding.efficiency.moderate * 0.7 + coding.efficiency.weak * 0.4;
    return coding.total > 0 && weighted / coding.total >= 0.5;
  })() : undefined;
  const passed = Number(reasoningPass) + Number(instructionsPass) + Number(toolsPass) + (codingPass !== undefined ? Number(codingPass) : 0);
  const total = coding ? 4 : 3;
  const allCodingStrong = coding?.efficiency ? coding.efficiency.strong === coding.total : coding?.passed === coding?.total;
  const label = coding
    ? passed === 4 ? reasoning === "STRONG" && allCodingStrong ? "STRONG" : "GOOD" : passed === 3 ? "USABLE" : passed === 2 ? "LIMITED" : passed === 1 ? "LIMITED" : "WEAK"
    : passed === 3 ? reasoning === "STRONG" ? "STRONG" : "GOOD" : passed === 2 ? "USABLE" : passed === 1 ? "LIMITED" : "WEAK";
  return { label, passed, total };
}

export function codingRecommendation(passed: number, total: number) {
  const ratio = total > 0 ? passed / total : 0;
  const label = total > 0 && passed === total ? "STRONG" : ratio >= 0.5 ? "GOOD" : passed > 0 ? "USABLE" : "WEAK";
  return { label, passed, total };
}

export function renderSummary(model: string, reasoning: { score: string; passed: number; total: number }, instructions: { score: string; passed: boolean; output: string }, tools: { score: string; passed: boolean; calls: string[]; response: string }, artifact: string | null, metrics: any, coding?: { passed: number; total: number }): string {
  const overall = recommendation(reasoning.score, instructions.passed, tools.passed, coding);
  const render = (score: string, text: string) => score === "STRONG" || score === "MODERATE" ? ok(text) : score === "WEAK" ? warn(text) : fail(text);
  return [section(`SIMPLEBENCH: ${model}`), render(reasoning.score, `Closed-answer contract: ${reasoning.score} (${reasoning.passed}/${reasoning.total})`), render(instructions.score, `Instructions: ${instructions.score}`), info(`Instruction output: ${instructions.output}`), render(tools.score, `Tool usage: ${tools.score} (${tools.calls.join(", ") || "none"})`), info(`Tool response: ${tools.response}`), ...(coding ? [render(coding.passed >= Math.ceil(coding.total / 2) ? "MODERATE" : "FAIL", `Coding Lite: ${coding.passed}/${coding.total}`)] : []), section("METRICS"), info(`Requests: ${metrics.requests}; tool calls: ${metrics.toolCalls}; latency avg/p95: ${Math.round(metrics.latency.averageMs)}ms/${metrics.latency.p95Ms}ms`), section("RECOMMENDATION"), render(overall.label, `${model} is ${overall.label} (${overall.passed}/${overall.total} capability categories passed)`), info(artifact ? `Artifact: ${artifact}` : "Artifact: disabled (--no-artifact)")].join("\n");
}
