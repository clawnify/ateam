import { expect, test } from "bun:test";
import { boxName } from "./box-name";

const connections = [
	{ alias: "100.64.0.7:8787", wake: { id: "sprites", box: { machine: "dev-box" } } },
	{ alias: "10.0.0.2:8787", wake: { id: "sprites", box: { machine: "  " } } },
	{ alias: "build-server", wake: null },
];

test("this Mac is Local", () => {
	expect(boxName(null, connections)).toBe("Local");
});

test("a box a provider wakes goes by its machine name there, not its address", () => {
	expect(boxName("100.64.0.7:8787", connections)).toBe("dev-box");
});

test("a box with no machine name goes by its alias", () => {
	expect(boxName("10.0.0.2:8787", connections)).toBe("10.0.0.2:8787");
	expect(boxName("build-server", connections)).toBe("build-server");
	// A task's box the app no longer lists (removed, or not loaded yet).
	expect(boxName("gone:8787", connections)).toBe("gone:8787");
});
