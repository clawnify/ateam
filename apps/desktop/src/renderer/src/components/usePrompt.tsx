import { type ReactNode, useState } from "react";

interface PromptState {
	kind: "input" | "confirm";
	title: string;
	body?: string;
	value: string;
	resolve: (v: string | null) => void;
}

/**
 * Electron disables window.prompt/alert/confirm, so we provide a tiny in-app
 * modal. `ask(title)` resolves to the entered string (or null on cancel);
 * `confirm(title, body)` resolves to true/false. Render `ui` near the app root.
 */
export function usePrompt(): {
	ui: ReactNode;
	ask: (title: string, initial?: string) => Promise<string | null>;
	confirm: (title: string, body?: string) => Promise<boolean>;
} {
	const [state, setState] = useState<PromptState | null>(null);

	const ask = (title: string, initial = "") =>
		new Promise<string | null>((resolve) => {
			setState({ kind: "input", title, value: initial, resolve });
		});

	const confirm = (title: string, body?: string) =>
		new Promise<boolean>((resolve) => {
			setState({
				kind: "confirm",
				title,
				body,
				value: "",
				resolve: (v) => resolve(v !== null),
			});
		});

	const close = (value: string | null) => {
		state?.resolve(value);
		setState(null);
	};

	const ui = state ? (
		<div className="overlay" onMouseDown={() => close(null)}>
			<div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
				<div className="dtitle">{state.title}</div>
				{state.body && (
					<div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
						{state.body}
					</div>
				)}
				{state.kind === "input" && (
					// biome-ignore lint/a11y/noAutofocus: modal input should focus
					<input
						autoFocus
						value={state.value}
						onChange={(e) => setState({ ...state, value: e.target.value })}
						onKeyDown={(e) => {
							if (e.key === "Enter") close(state.value.trim() || null);
							if (e.key === "Escape") close(null);
						}}
					/>
				)}
				<div className="drow">
					<button type="button" onClick={() => close(null)}>
						Cancel
					</button>
					<button
						type="button"
						className="primary"
						onClick={() =>
							close(state.kind === "confirm" ? "ok" : state.value.trim() || null)
						}
					>
						{state.kind === "confirm" ? "Confirm" : "OK"}
					</button>
				</div>
			</div>
		</div>
	) : null;

	return { ui, ask, confirm };
}
