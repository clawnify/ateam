import { requireOptionalNativeModule } from "expo";

export interface SSHNative {
	createKey(id: string): Promise<string>;
	savePassword(id: string, password: string): Promise<void>;
	removeIdentity(id: string): Promise<void>;
	/** Only the password, keeping the identity's key. */
	removePassword(id: string): Promise<void>;
	fingerprint(key: string): Promise<string>;
	open(
		id: string,
		host: string,
		port: number,
		user: string,
		identity: string,
		auth: string,
		hostKey: string | null,
	): Promise<void>;
	exec(id: string, command: string): Promise<{ stdout: string; stderr: string; code: number }>;
	attach(id: string): Promise<void>;
	write(id: string, line: string): Promise<void>;
	forward(id: string, port: number): Promise<number>;
	close(id: string): Promise<void>;
	addListener(
		event: "line" | "closed",
		listener: (event: { id: string; line?: string; message?: string }) => void,
	): { remove(): void };
}

const native = requireOptionalNativeModule<SSHNative>("ExpoSSH");
export const sshAvailable = native !== null;
export function sshNative(): SSHNative {
	if (!native) throw new Error("SSH needs a newer iOS build of Ateam Go. Update the app first.");
	return native;
}
