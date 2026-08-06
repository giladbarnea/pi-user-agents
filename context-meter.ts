import type { CompletedAgent, RunningAgent, Theme } from "./shared.js";

const CONTEXT_METER_SYMBOLS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const CONTEXT_MUTED_THRESHOLD = 40;
const CONTEXT_WARNING_THRESHOLD = 65;
const CONTEXT_ERROR_THRESHOLD = 85;

type ContextMeterAgent = RunningAgent | CompletedAgent;
type ContextMeterColor = "dim" | "muted" | "warning" | "error";

/** @example contextMeterColor(85) // "error" */
export function contextMeterColor(percent: number): ContextMeterColor {
	if (percent >= CONTEXT_ERROR_THRESHOLD) return "error";
	if (percent >= CONTEXT_WARNING_THRESHOLD) return "warning";
	if (percent >= CONTEXT_MUTED_THRESHOLD) return "muted";
	return "dim";
}

export function renderContextMeter(
	percent: number | null | undefined,
	theme: Pick<Theme, "fg">,
): string {
	if (percent === null || percent === undefined) return "";
	const boundedPercent = Math.max(0, Math.min(100, percent));
	const level = Math.min(
		CONTEXT_METER_SYMBOLS.length - 1,
		Math.floor(boundedPercent / (100 / CONTEXT_METER_SYMBOLS.length)),
	);
	return theme.fg(contextMeterColor(boundedPercent), CONTEXT_METER_SYMBOLS[level]);
}

/** Render the current or final context usage for either agent state. */
export function renderAgentContextMeter(
	agent: ContextMeterAgent,
	theme: Pick<Theme, "fg">,
): string {
	const percent = "status" in agent
		? agent.session?.getContextUsage()?.percent
		: agent.contextPercent;
	return renderContextMeter(percent, theme);
}
