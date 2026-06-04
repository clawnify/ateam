export type GitCoreErrorCode =
	| "NOT_A_REPO"
	| "ALREADY_A_REPO"
	| "INVALID_NAME"
	| "PATH_TRAVERSAL"
	| "NO_DEFAULT_BRANCH"
	| "MERGE_CONFLICT"
	| "GH_FAILED"
	| "GENERIC";

/**
 * The single error type git-core throws. Carries a machine-readable `code`
 * (so the Electron/IPC layer can branch without string-matching messages) plus
 * the original `cause` for logging.
 */
export class GitCoreError extends Error {
	readonly code: GitCoreErrorCode;
	override readonly cause?: unknown;

	constructor(code: GitCoreErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "GitCoreError";
		this.code = code;
		this.cause = cause;
	}
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
