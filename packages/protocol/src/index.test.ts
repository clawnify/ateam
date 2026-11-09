// The client floor: when a box running a newer protocol asks a client to update.
import { describe, expect, test } from "bun:test";
import { clientBelowFloor, MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from "./index";

describe("client floor", () => {
	test("a newer box above the client's floor asks nothing of it", () => {
		expect(clientBelowFloor(34, { protocolVersion: 40, minClient: 29 })).toBe(false);
	});

	test("a newer box whose floor is above the client asks it to update", () => {
		expect(clientBelowFloor(28, { protocolVersion: 40, minClient: 29 })).toBe(true);
	});

	test("an engine that doesn't say serves the client, and an older box is never this case", () => {
		expect(clientBelowFloor(34, { protocolVersion: 35 })).toBe(false);
		expect(clientBelowFloor(34, { protocolVersion: 30, minClient: 99 })).toBe(false);
		expect(clientBelowFloor(34, { protocolVersion: 34, minClient: 29 })).toBe(false);
	});

	test("the floor never passes the protocol this release speaks", () => {
		expect(MIN_CLIENT_PROTOCOL).toBeLessThanOrEqual(PROTOCOL_VERSION);
	});
});
