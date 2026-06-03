// Ateam is a local git client, so inherited user git config/hooks/env are
// expected behavior. simple-git (>=3.36) gates these behind explicit "unsafe"
// opt-ins; we enable them centrally. The flag names below are simple-git's own
// option surface (see simple-git's SimpleGitOptions.unsafe).

export const SIMPLE_GIT_UNSAFE_OPTION_FLAGS = [
	"allowUnsafeAlias",
	"allowUnsafeAskPass",
	"allowUnsafeConfigEnvCount",
	"allowUnsafeConfigPaths",
	"allowUnsafeCredentialHelper",
	"allowUnsafeCustomBinary",
	"allowUnsafeDiffExternal",
	"allowUnsafeDiffTextConv",
	"allowUnsafeEditor",
	"allowUnsafeFilter",
	"allowUnsafeFsMonitor",
	"allowUnsafeGitProxy",
	"allowUnsafeGpgProgram",
	"allowUnsafeHooksPath",
	"allowUnsafeMergeDriver",
	"allowUnsafePack",
	"allowUnsafePager",
	"allowUnsafeProtocolOverride",
	"allowUnsafeSshCommand",
	"allowUnsafeTemplateDir",
] as const;

export type SimpleGitUnsafeOptionFlag =
	(typeof SIMPLE_GIT_UNSAFE_OPTION_FLAGS)[number];

export const USER_GIT_ENV_SIMPLE_GIT_OPTIONS: {
	unsafe: Record<SimpleGitUnsafeOptionFlag, true>;
} = {
	unsafe: Object.fromEntries(
		SIMPLE_GIT_UNSAFE_OPTION_FLAGS.map((flag) => [flag, true]),
	) as Record<SimpleGitUnsafeOptionFlag, true>,
};
