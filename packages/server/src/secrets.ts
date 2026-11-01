// What looks like a credential in text the user typed or an agent wrote, before
// that text is sent to a model that is not the task's own agent (Jev for the
// grammar filter; the text model for titles and summaries).

/** A known token prefix followed by the token. */
const PREFIXED = /\b(sk-|sk_live_|gh[pousr]_|github_pat_|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g;
/** A long unbroken run of letters and digits, such as a key or a hash. */
const LONG_RUN = /[A-Za-z0-9_-]{32,}/g;

/** A long run counts only when it mixes letters and digits: a long identifier
 *  like `syncEngineSettingsToBoxesEverywhereAtOnce` is not a key. */
const keyLike = (run: string) => /\d/.test(run) && /[A-Za-z]/.test(run);

/**
 * Whether text may hold a credential. Such a grammar draft is not sent at all;
 * a false alarm only means Harper's list shows unfiltered.
 */
export function looksSecret(text: string): boolean {
	if (new RegExp(PREFIXED.source).test(text)) return true;
	return (text.match(LONG_RUN) ?? []).some(keyLike);
}

/**
 * The same text with every credential-looking run replaced by `[redacted]`.
 * For text that must still be sent (a summary needs the prompts it summarizes),
 * so it errs toward removing: a lost commit hash costs a summary nothing.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(PREFIXED, "[redacted]")
		.replace(LONG_RUN, (run) => (keyLike(run) ? "[redacted]" : run));
}
