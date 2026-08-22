import { fail, info, ok, section, warn, msHuman } from "./util/format";

export const branding = "  ⚡ OPL Simplebench";
export function formatTestSummary(tests: Array<{ name: string; pass: boolean; score: string }>, totalMs: number): string[] {
  return [section("SUMMARY"), ...tests.map(t => t.pass ? ok(`${t.name}: ${t.score}`) : fail(`${t.name}: ${t.score}`)), info(`Total time: ${msHuman(totalMs)}`), info(`Score: ${tests.filter(t => t.pass).length}/${tests.length} tests passed`)];
}
/** Legacy-compatible category recommendation. New runner uses recommendation() above. */
export function formatRecommendation(model: string, passed: number, total: number): string[] {
  const label = passed === total ? "STRONG" : passed >= total - 1 ? "GOOD" : passed >= total - 2 ? "USABLE" : "WEAK";
  return [section("RECOMMENDATION"), label === "WEAK" ? fail(`${model} is ${label}`) : ok(`${model} is ${label}`)];
}

export function recommendation(reasoning: string, instructionsPass: boolean, toolsPass: boolean) {
  const passed = (reasoning === "STRONG" || reasoning === "MODERATE" ? 1 : 0) + Number(instructionsPass) + Number(toolsPass);
  const label = passed === 3 ? reasoning === "STRONG" ? "STRONG" : "GOOD" : passed === 2 ? "USABLE" : passed === 1 ? "LIMITED" : "WEAK";
  return { label, passed };
}

export function renderSummary(model: string, reasoning: { score: string; passed: number; total: number }, instructions: { score: string; passed: boolean; output: string }, tools: { score: string; passed: boolean; calls: string[]; response: string }, artifact: string | null, metrics: any): string {
  const overall = recommendation(reasoning.score, instructions.passed, tools.passed);
  const render = (score: string, text: string) => score === "STRONG" || score === "MODERATE" ? ok(text) : score === "WEAK" ? warn(text) : fail(text);
  return [section(`SIMPLEBENCH: ${model}`), render(reasoning.score, `Reasoning: ${reasoning.score} (${reasoning.passed}/${reasoning.total})`), render(instructions.score, `Instructions: ${instructions.score}`), info(`Instruction output: ${instructions.output}`), render(tools.score, `Tool usage: ${tools.score} (${tools.calls.join(", ") || "none"})`), info(`Tool response: ${tools.response}`), section("METRICS"), info(`Requests: ${metrics.requests}; tool calls: ${metrics.toolCalls}; latency avg/p95: ${Math.round(metrics.latency.averageMs)}ms/${metrics.latency.p95Ms}ms`), section("RECOMMENDATION"), render(overall.label, `${model} is ${overall.label} (${overall.passed}/3 capability categories passed)`), info(artifact ? `Artifact: ${artifact}` : "Artifact: disabled (--no-artifact)")].join("\n");
}
