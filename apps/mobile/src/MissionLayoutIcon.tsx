// The same Lucide 1.17.0 geometry as desktop's Mission Control buttons:
// LayoutDashboard, LayoutGrid, Grid3x2, LayoutPanelLeft, Columns2, Rows2.
// ISC License — Copyright (c) 2026 Lucide Icons and Contributors
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
import type { McChoice } from "@ateam/panes";
import Svg, { Path, Rect } from "react-native-svg";

export function MissionLayoutIcon({ layout, color }: { layout: McChoice; color: string }) {
	return (
		<Svg
			width={16}
			height={16}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth={1.75}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			{layout === "auto" ? (
				<>
					<Rect x={3} y={3} width={7} height={9} rx={1} />
					<Rect x={14} y={3} width={7} height={5} rx={1} />
					<Rect x={14} y={12} width={7} height={9} rx={1} />
					<Rect x={3} y={16} width={7} height={5} rx={1} />
				</>
			) : layout === "grid" ? (
				<>
					<Rect x={3} y={3} width={7} height={7} rx={1} />
					<Rect x={14} y={3} width={7} height={7} rx={1} />
					<Rect x={14} y={14} width={7} height={7} rx={1} />
					<Rect x={3} y={14} width={7} height={7} rx={1} />
				</>
			) : layout === "main" ? (
				<>
					<Rect x={3} y={3} width={7} height={18} rx={1} />
					<Rect x={14} y={3} width={7} height={7} rx={1} />
					<Rect x={14} y={14} width={7} height={7} rx={1} />
				</>
			) : (
				<>
					<Rect x={3} y={3} width={18} height={18} rx={2} />
					{layout === "grid3x2" ? (
						<Path d="M15 3v18 M3 12h18 M9 3v18" />
					) : (
						<Path d={layout === "split" ? "M12 3v18" : "M3 12h18"} />
					)}
				</>
			)}
		</Svg>
	);
}
