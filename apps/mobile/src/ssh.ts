import { SSH_INSTALL_COMMAND, SSH_INSTALL_STATUS } from "@ateam/protocol";
import { randomUUID } from "expo-crypto";
import { Alert } from "react-native";
import { sshNative } from "../modules/expo-ssh/src";
import { sshTransport } from "./ssh-transport";
import type { SavedConnection } from "./storage";

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const ask = (title: string, message: string, action: string) =>
	new Promise<boolean>((resolve) => {
		Alert.alert(
			title,
			message,
			[
				{ text: "Cancel", style: "cancel", onPress: () => resolve(false) },
				{ text: action, onPress: () => resolve(true) },
			],
			{ cancelable: true, onDismiss: () => resolve(false) },
		);
	});

/** No prompts on reconnect. Unknown/changed host keys are resolved only by the
 * explicit setup flow, never accepted by a retry running behind the board. */
export async function openSSH(box: SavedConnection) {
	const ssh = box.ssh;
	if (!ssh) throw new Error("Missing SSH settings");
	const native = sshNative();
	const id = randomUUID();
	try {
		await native.open(
			id,
			box.host,
			Number(box.port || 22),
			ssh.user,
			ssh.identity,
			ssh.auth,
			ssh.hostKey ?? null,
		);
		return { native, id };
	} catch (e) {
		await native.close(id).catch(() => {});
		throw e;
	}
}

export async function sshClient(box: SavedConnection) {
	if (!box.ssh?.hostKey) throw new Error("Open Edit box to verify its SSH host key first.");
	try {
		const { native, id } = await openSSH(box);
		const client = sshTransport(native, id);
		try {
			const status = await native.exec(id, SSH_INSTALL_STATUS);
			if (status.code === 75) throw new Error("Ateam is still installing. Reconnect in a moment.");
			if (status.code)
				throw new Error("Ateam setup did not finish. Open Edit box to retry installation.");
			await client.start();
			return client;
		} catch (e) {
			client.close();
			throw e;
		}
	} catch (e) {
		if (String(e).includes("SSH_HOST_KEY:")) {
			throw new Error(
				"SSH host key changed. Connection blocked. Verify the server identity before adding it again.",
			);
		}
		throw e;
	}
}

export async function verifySSH(box: SavedConnection): Promise<SavedConnection> {
	if (!box.ssh) throw new Error("Missing SSH settings");
	let connection: Awaited<ReturnType<typeof openSSH>>;
	try {
		connection = await openSSH(box);
	} catch (e) {
		const key = String(e).match(
			/SSH_HOST_KEY:(ssh-[A-Za-z0-9-]+ [A-Za-z0-9+/=]+|ecdsa-[A-Za-z0-9-]+ [A-Za-z0-9+/=]+)/,
		)?.[1];
		if (!key) throw e;
		if (box.ssh.hostKey)
			throw new Error("SSH host key changed. Verify the server identity before adding it again.");
		const fingerprint = await sshNative().fingerprint(key);
		if (
			!(await ask(
				"Trust this SSH host?",
				`${box.host}:${box.port}\n\n${fingerprint}\n\nCompare this fingerprint with the server's console before trusting it.`,
				"Trust host",
			))
		)
			throw new Error("SSH host was not trusted.");
		box = { ...box, ssh: { ...box.ssh, hostKey: key } };
		connection = await openSSH(box);
	}
	await connection.native.close(connection.id);
	return box;
}

/** User-initiated setup, also used after creating a provider box. Remember the
 * verified address before installing so leaving the app cannot lose access.
 * `installed`: this setup ran Ateam's installer, so the box is new to Ateam and has
 * no coding agent yet (the installer adds none). */
export async function prepareSSH(
	box: SavedConnection,
	remember: (box: SavedConnection) => Promise<void>,
	progress: (text: string) => void,
): Promise<{ box: SavedConnection; installed: boolean }> {
	if (!box.ssh) return { box, installed: false };
	let opened: Awaited<ReturnType<typeof openSSH>> | null = null;
	try {
		progress("Verifying SSH access…");
		box = await verifySSH(box);
		opened = await openSSH(box);
		await remember(box);
		let { native, id } = opened;
		if (box.ssh?.user === "root") {
			if (
				!(await ask(
					"Set up an Ateam user?",
					"Ateam runs as a regular user. Create an ateam account with sudo access and authorize a key stored on this phone? An existing account created outside this setup will be left alone.",
					"Set up user",
				))
			) {
				throw new Error("Connect as a non-root user to run Ateam.");
			}
			// The same reference has separate password/key Keychain items. A retry
			// after suspension recovers this key through the already saved root box.
			const identity = box.ssh.identity;
			const publicKey = await native.createKey(identity);
			const result = await native.exec(
				id,
				[
					"set -eu",
					"command -v useradd >/dev/null",
					"command -v sudo >/dev/null",
					"command -v visudo >/dev/null",
					"install -d -m 700 /var/lib/ateam-go",
					`if id ateam >/dev/null 2>&1; then grep -qxF ${shellQuote(publicKey)} /var/lib/ateam-go/bootstrap-key || { echo 'The ateam user already exists. Connect as that user instead.' >&2; exit 70; }; else printf '%s\\n' ${shellQuote(publicKey)} > /var/lib/ateam-go/bootstrap-key; useradd -m -U -s /bin/bash ateam; fi`,
					"test $(getent passwd ateam | cut -d: -f6) = /home/ateam",
					"test ! -L /home/ateam && test ! -L /home/ateam/.ssh && test ! -L /home/ateam/.ssh/authorized_keys",
					"test ! -e /etc/sudoers.d/ateam-go || grep -qxF 'ateam ALL=(ALL) NOPASSWD:ALL' /etc/sudoers.d/ateam-go",
					"install -d -m 700 -o ateam -g ateam /home/ateam/.ssh",
					`grep -qxF ${shellQuote(publicKey)} /home/ateam/.ssh/authorized_keys 2>/dev/null || printf '%s\\n' ${shellQuote(publicKey)} >> /home/ateam/.ssh/authorized_keys`,
					"chown ateam:ateam /home/ateam/.ssh/authorized_keys",
					"chmod 600 /home/ateam/.ssh/authorized_keys",
					"printf 'ateam ALL=(ALL) NOPASSWD:ALL\\n' > /etc/sudoers.d/ateam-go",
					"chmod 440 /etc/sudoers.d/ateam-go",
					"visudo -cf /etc/sudoers.d/ateam-go",
				].join("; "),
			);
			if (result.code) throw new Error(`Could not set up the ateam user: ${result.stderr}`);
			await native.close(id);
			box = { ...box, ssh: { ...box.ssh, user: "ateam", auth: "key", identity } };
			await remember(box);
			// The saved box logs in by key now, so root's password has no further use here.
			await native.removePassword(identity).catch(() => {});
			opened = await openSSH(box);
			({ native, id } = opened);
		}
		const check = () => native.exec(id, "bash -lc 'command -v ateam'");
		const initial = await native.exec(id, SSH_INSTALL_STATUS);
		if (initial.code && initial.code !== 74 && initial.code !== 75)
			throw new Error(
				"Could not check the previous installation. This setup needs Linux with flock.",
			);
		if (initial.code !== 0 || (await check()).code !== 0) {
			if (initial.code !== 75) {
				if (
					!(await ask(
						"Install Ateam on this box?",
						"Download and install Ateam for this SSH user. The installer may use sudo to install its service. Progress is saved in ~/ateam-install.log and continues if the phone disconnects.",
						"Install",
					))
				) {
					throw new Error("Ateam is not installed on the box.");
				}
				// flock prevents duplicate installers after a retry. The detached process
				// owns its log and exit marker, independent of this SSH channel.
				const start = await native.exec(
					id,
					`bash -lc ${shellQuote(`command -v flock >/dev/null || exit 69; nohup ${SSH_INSTALL_COMMAND} > /dev/null 2>&1 < /dev/null &`)}`,
				);
				if (start.code)
					throw new Error(
						"Could not start the installer. This setup needs Linux with bash and flock.",
					);
			}
			progress("Installing Ateam on the box… You can return later if disconnected.");
			for (let attempt = 0; attempt < 60; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 5000));
				const status = await native.exec(id, SSH_INSTALL_STATUS);
				if (status.code === 75) continue;
				if (status.code)
					throw new Error(`Installation did not finish. Reconnect to retry. ${status.stderr}`);
				if ((await check()).code === 0) return { box, installed: true };
			}
			throw new Error(
				"The box is still installing. It is saved; reconnect later. See ~/ateam-install.log on the box.",
			);
		}
		return { box, installed: false };
	} finally {
		if (opened) await opened.native.close(opened.id).catch(() => {});
	}
}
