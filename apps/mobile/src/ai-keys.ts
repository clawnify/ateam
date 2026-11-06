// The AI keys a box uses, as AiKeysScreen asks for them: which field each one is,
// where it's made, and the checks on a pasted key. Pure TS, so ai-keys.test.ts runs
// under bun. The desktop's fields are Settings → AI (SettingsPanel.tsx KeyField).
import type { CredentialStatus, CredentialsPatch } from "@ateam/protocol";

export type AiKeyProvider = "openAi" | "openRouter";

export interface AiKeyField {
	provider: AiKeyProvider;
	/** The CredentialsPatch field it is saved as. */
	field: keyof CredentialsPatch;
	label: string;
	placeholder: string;
	/** What it turns on, in one line under the label. */
	purpose: string;
	/** Where the key is made: a button opens `url`, and `path` says where that is. */
	console: { url: string; path: string };
	optional: boolean;
}

export const AI_KEY_FIELDS: readonly AiKeyField[] = [
	{
		provider: "openAi",
		field: "openAiApiKey",
		label: "OpenAI API key",
		placeholder: "sk-…",
		purpose:
			"Calls with the Lead, and a small model that moves a finished task to Needs you when its agent is waiting on you.",
		console: {
			url: "https://platform.openai.com/api-keys",
			path: "platform.openai.com › API keys",
		},
		optional: false,
	},
	{
		provider: "openRouter",
		field: "openRouterApiKey",
		label: "OpenRouter API key",
		placeholder: "sk-or-…",
		purpose: "Does that sorting through OpenRouter instead. Not needed with an OpenAI key.",
		console: {
			url: "https://openrouter.ai/settings/keys",
			path: "openrouter.ai › Settings › API Keys",
		},
		optional: true,
	},
];

/** A key as pasted, without the spaces and line breaks a copy can bring along. */
export function cleanKey(pasted: string): string {
	return pasted.replace(/\s+/g, "");
}

/** Why a pasted key belongs in the other field, or null. */
export function wrongField(provider: AiKeyProvider, pasted: string): string | null {
	const key = cleanKey(pasted);
	if (provider === "openAi" && key.startsWith("sk-or-")) {
		return "That's an OpenRouter key: it goes in the OpenRouter field.";
	}
	if (provider === "openRouter" && key.startsWith("sk-") && !key.startsWith("sk-or-")) {
		return "That looks like an OpenAI key: OpenRouter keys start with sk-or-.";
	}
	return null;
}

/** What a saved key's row says: never the key, only its last four characters. */
export function savedKeyLine(status: CredentialStatus): string {
	const hint = status.hint ? ` ····${status.hint}` : "";
	return status.source === "env" ? `From the box's environment${hint}` : `Saved${hint}`;
}
