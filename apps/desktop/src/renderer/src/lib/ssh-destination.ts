// What "Set up a box over SSH" sets up, from what was typed: a box's name in
// ~/.ssh/config, or user@host. Providers print the command to connect
// (`ssh mybox.exe.xyz`), and that is what gets pasted, so its `ssh` goes. Whatever
// still has a space in it (an option, two names) isn't one place ssh can go.

export function sshDestination(input: string): { dest: string } | { problem: string } {
	const dest = input
		.trim()
		.replace(/^ssh\s+/, "")
		.trim();
	if (!dest || dest === "ssh") {
		return { problem: "Type the box's name in your ssh config, or user@host." };
	}
	if (/\s/.test(dest) || dest.startsWith("-")) {
		return {
			problem:
				"Give just the box: its name in your ssh config (like mybox.exe.xyz) or user@host. A port or key goes in ~/.ssh/config.",
		};
	}
	return { dest };
}
