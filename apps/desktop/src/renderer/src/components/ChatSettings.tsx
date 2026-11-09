import type {
	ChatAgent,
	ChatSettingsResult,
	ConnectionDTO,
	ChatSettings as Preferences,
} from "@ateam/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./BoxPage";

const LABEL: Record<ChatAgent, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
};
const AUTO: Record<ChatAgent, string> = {
	claude:
		"Claude's native Auto mode reviews tool requests. Availability depends on your Claude account and configuration.",
	codex: "Codex's automatic reviewer evaluates tool requests while keeping its workspace sandbox.",
	opencode:
		"OpenCode approves tool requests automatically unless its permission rules explicitly deny them.",
};

export function ChatSettings() {
	const [machine, setMachine] = useState<string | null>(null);
	const [boxes, setBoxes] = useState<ConnectionDTO[]>([]);
	const [result, setResult] = useState<ChatSettingsResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const sequence = useRef(0);
	const load = useCallback(async () => {
		const seq = ++sequence.current;
		try {
			const r = await window.ateamLead.settings(machine);
			if (seq === sequence.current) {
				setResult(r);
				setError(null);
			}
		} catch (e) {
			if (seq === sequence.current) {
				setResult(null);
				setError(errorText(e));
			}
		}
	}, [machine]);
	useEffect(() => {
		let live = true;
		void window.ateamHost.list().then((v) => {
			if (live) setBoxes(v);
		});
		void window.ateamLead.home().then((v) => {
			if (live) setMachine(v.box);
		});
		return () => {
			live = false;
		};
	}, []);
	useEffect(() => {
		setResult(null);
		void load();
		const refresh = () => {
			void load();
		};
		window.addEventListener("focus", refresh);
		const off = window.ateamLead.onEvent((event) => {
			if (event.type === "auto") refresh();
		});
		return () => {
			++sequence.current;
			window.removeEventListener("focus", refresh);
			off();
		};
	}, [load]);
	const patch = async (p: Partial<Preferences>) => {
		const seq = ++sequence.current;
		setSaving(true);
		setError(null);
		try {
			const r = await window.ateamLead.updateSettings(machine, p);
			if (seq === sequence.current) setResult(r);
		} catch (e) {
			if (seq === sequence.current) setError(errorText(e));
		} finally {
			setSaving(false);
		}
	};
	return (
		<>
			<h3>Chat</h3>
			<p className="settings-section-intro">
				Choose the agent and Auto mode for Chat on each machine. These settings apply to every Chat
				conversation running there and are never synced to other machines. Task agents keep their
				own settings.
			</p>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<div className="settings-row-title">Machine</div>
						<div className="settings-row-desc">
							A box uses the same settings when you talk to it from your Mac or phone.
						</div>
					</div>
					<div className="settings-row-control">
						<select
							aria-label="Chat machine"
							className="settings-select"
							disabled={saving}
							value={machine ?? ""}
							onChange={(e) => setMachine(e.target.value || null)}
						>
							<option value="">This Mac</option>
							{boxes.map((b) => (
								<option key={b.alias} value={b.alias}>
									{b.alias}
								</option>
							))}
						</select>
					</div>
				</div>
				{result && (
					<>
						<div className="settings-row" data-setting="chat.agent">
							<div className="settings-row-text">
								<div className="settings-row-title">Agent</div>
								<div className="settings-row-desc">
									Uses this machine's agent login and configured model. Changes take effect on the
									next turn; conversation history is kept.
								</div>
							</div>
							<div className="settings-row-control">
								<select
									aria-label="Chat agent"
									className="settings-select"
									disabled={saving}
									value={result.settings.agent}
									onChange={(e) => void patch({ agent: e.target.value as ChatAgent })}
								>
									{result.agents.map((a) => (
										<option key={a.id} value={a.id} disabled={!a.available}>
											{LABEL[a.id]}
											{a.available ? "" : " — install on this machine"}
										</option>
									))}
								</select>
							</div>
						</div>
						<div className="settings-row" data-setting="chat.auto">
							<div className="settings-row-text">
								<div className="settings-row-title">Auto mode</div>
								<div className="settings-row-desc">
									{AUTO[result.settings.agent]} Turning Auto off may stop an active turn so it
									cannot continue under the old policy.
								</div>
							</div>
							<div className="settings-row-control">
								<button
									type="button"
									role="switch"
									aria-label="Chat Auto mode"
									aria-checked={result.settings.auto}
									disabled={saving}
									className={`settings-switch ${result.settings.auto ? "on" : ""}`}
									onClick={() => void patch({ auto: !result.settings.auto })}
								>
									<span className="settings-switch-knob" />
								</button>
							</div>
						</div>
					</>
				)}
			</div>
			{error && (
				<p role="alert" className="settings-warning">
					{error}
				</p>
			)}
			{!result && !error && <p>Loading Chat settings…</p>}
		</>
	);
}
