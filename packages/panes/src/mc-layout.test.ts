import { expect, test } from "bun:test";
import {
	bestMcShape,
	fixedMcShape,
	MC_PAGE_SIZE,
	type McLayout,
	mcCapacity,
	mcShapeGrid,
	mcShapeRects,
} from "./mc-layout";

test("native fixed layouts match desktop slot counts and main/side placement", () => {
	for (const layout of Object.keys(MC_PAGE_SIZE) as McLayout[]) {
		const shape = fixedMcShape(layout);
		expect(mcShapeRects(shape, { width: 1000, height: 800 })).toHaveLength(MC_PAGE_SIZE[layout]);
		expect(mcShapeGrid(shape).tiles).toHaveLength(MC_PAGE_SIZE[layout]);
	}
	expect(mcShapeRects(fixedMcShape("main"), { width: 1000, height: 800 })).toEqual([
		{ left: 0, top: 0, width: 500, height: 800 },
		{ left: 500, top: 0, width: 500, height: 400 },
		{ left: 500, top: 400, width: 500, height: 400 },
	]);
});

test("native Auto frames fill iPad and compact windows without gaps or overlaps", () => {
	for (const width of [403, 744, 1032 - 280, 1032 - 56, 1376 - 280]) {
		for (const height of [350, 700, 1000]) {
			const area = { width, height };
			const capacity = mcCapacity(area);
			for (let n = 1; n <= capacity; n++) {
				const shape = bestMcShape(n, area);
				const frames = mcShapeRects(shape, area);
				expect(frames).toHaveLength(n);
				expect(frames.reduce((sum, r) => sum + r.width * r.height, 0)).toBeCloseTo(width * height);
				for (const [i, r] of frames.entries()) {
					expect(r.left).toBeGreaterThanOrEqual(0);
					expect(r.top).toBeGreaterThanOrEqual(0);
					expect(r.left + r.width).toBeLessThanOrEqual(width + 1e-6);
					expect(r.top + r.height).toBeLessThanOrEqual(height + 1e-6);
					for (const s of frames.slice(i + 1)) {
						const overlapW =
							Math.min(r.left + r.width, s.left + s.width) - Math.max(r.left, s.left);
						const overlapH = Math.min(r.top + r.height, s.top + s.height) - Math.max(r.top, s.top);
						expect(Math.min(overlapW, overlapH)).toBeLessThanOrEqual(1e-6);
					}
				}
			}
		}
	}
});
