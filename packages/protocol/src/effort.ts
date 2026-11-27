export const EFFORT_LEVELS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export interface AgentEffort {
	model: string;
	levels: Effort[];
}

export function isEffort(value: unknown): value is Effort {
	return EFFORT_LEVELS.some((level) => level === value);
}

export function resolveEffort(requested: Effort, levels: readonly Effort[]): Effort | null {
	return (
		EFFORT_LEVELS.slice(0, EFFORT_LEVELS.indexOf(requested) + 1)
			.reverse()
			.find((level) => levels.includes(level)) ?? null
	);
}

export function effortLabel(effort: Effort | null): string {
	if (!effort) return "Default";
	return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}
