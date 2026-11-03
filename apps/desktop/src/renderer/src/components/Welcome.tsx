// The first run (ateamTheme.firstRun says when): pick a theme before the board
// opens. Each preview is a miniature board drawn in its own theme's tokens
// (data-theme on the preview; index.css lets any element carry one). Picking
// one repaints this window but saves nothing, so quitting here brings the
// screen back next launch; Continue saves it.
import type { ThemeId } from "@ateam/protocol";
import { useState } from "react";
import { THEMES } from "../../../shared/theme";
import { activeTheme, applyTheme } from "../lib/theme";

export function Welcome({ onDone }: { onDone: () => void }) {
	const [choice, setChoice] = useState<ThemeId>(activeTheme);
	const [saving, setSaving] = useState(false);

	// Native radios: the arrow keys move the choice, and each move repaints.
	const pick = (id: ThemeId) => {
		setChoice(id);
		applyTheme(id);
	};

	const finish = async () => {
		setSaving(true);
		try {
			await window.ateamTheme.set(choice);
			onDone();
		} finally {
			setSaving(false);
		}
	};

	return (
		<main className="welcome">
			<div className="welcome-body">
				<h1>Welcome to Ateam</h1>
				<p>Choose how it looks. You can change this later in Settings.</p>
				<fieldset className="welcome-themes">
					<legend className="welcome-legend">Theme</legend>
					{THEMES.map((t) => (
						<label key={t.id} className="welcome-theme">
							<input
								type="radio"
								name="theme"
								value={t.id}
								checked={choice === t.id}
								onChange={() => pick(t.id)}
								className="welcome-radio"
							/>
							<ThemePreview id={t.id} />
							<span className="welcome-theme-name">{t.label}</span>
						</label>
					))}
				</fieldset>
				<button type="button" className="primary welcome-go" disabled={saving} onClick={finish}>
					Continue
				</button>
			</div>
		</main>
	);
}

/** The sidebar, three columns and a few cards, in the theme `id`. */
function ThemePreview({ id }: { id: ThemeId }) {
	return (
		<div className="welcome-preview" data-theme={id} aria-hidden="true">
			<div className="wp-side">
				<i className="wp-line wide" />
				<i className="wp-line" />
				<i className="wp-line" />
			</div>
			<div className="wp-board">
				<div className="wp-col">
					<div className="wp-card">
						<i className="wp-dot blue" />
					</div>
				</div>
				<div className="wp-col">
					<div className="wp-card">
						<i className="wp-dot amber" />
					</div>
				</div>
				<div className="wp-col">
					<div className="wp-card">
						<i className="wp-dot green" />
					</div>
					<div className="wp-card" />
				</div>
			</div>
		</div>
	);
}
