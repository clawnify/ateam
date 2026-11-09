import { CH } from "./channels";
import type { RpcClient } from "./rpc";

export interface DotfilesConfig {
	repository: string;
	/** Relative executable path; empty uses the conventional script names. */
	script: string;
}

export interface DotfilesPlan {
	id: string;
	config: DotfilesConfig;
	commit: string;
	directory: string;
	script: string | null;
}

export interface DotfilesRun {
	plan: DotfilesPlan;
	state: "running" | "succeeded" | "failed" | "interrupted";
	startedAt: number;
	finishedAt: number | null;
	exitCode: number | null;
	message: string | null;
	log: string;
}

export interface DotfilesStatus {
	defaultConfig: DotfilesConfig | null;
	prepared: DotfilesPlan | null;
	run: DotfilesRun | null;
}

export interface DotfilesClient {
	status(): Promise<DotfilesStatus>;
	/** Fetch a clean checkout and detect its script, without running it. */
	prepare(config: DotfilesConfig): Promise<DotfilesPlan>;
	/** Start exactly the previewed revision. Poll status for progress. */
	apply(planId: string): Promise<DotfilesStatus>;
}

/** Box-scoped, deliberately outside the board's aggregate API. */
export function dotfilesClient(rpc: Pick<RpcClient, "call">): DotfilesClient {
	return {
		status: () => rpc.call(CH.dotfilesStatus) as Promise<DotfilesStatus>,
		prepare: (config) => rpc.call(CH.dotfilesPrepare, [config]) as Promise<DotfilesPlan>,
		apply: (id) => rpc.call(CH.dotfilesApply, [id]) as Promise<DotfilesStatus>,
	};
}
