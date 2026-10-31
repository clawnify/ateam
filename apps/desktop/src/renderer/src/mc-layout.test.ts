import { expect, test } from "bun:test";
import { bestMcLayout, MC_PAGE_SIZE } from "./mc-layout";

test("Auto picks the smallest layout that shows every tile on one page", () => {
	expect(bestMcLayout(1)).toBe("stack");
	expect(bestMcLayout(2)).toBe("split");
	expect(bestMcLayout(3)).toBe("main");
	expect(bestMcLayout(4)).toBe("grid");
	expect(bestMcLayout(5)).toBe("grid3x2");
	expect(bestMcLayout(6)).toBe("grid3x2");
});

test("past six tiles Auto stays on the 3x2 and pages the rest", () => {
	expect(bestMcLayout(7)).toBe("grid3x2");
	expect(bestMcLayout(40)).toBe("grid3x2");
});

test("every pick holds the tiles on one page while they fit on one", () => {
	const most = Math.max(...Object.values(MC_PAGE_SIZE));
	for (let n = 1; n <= most; n++) expect(MC_PAGE_SIZE[bestMcLayout(n)]).toBeGreaterThanOrEqual(n);
});
