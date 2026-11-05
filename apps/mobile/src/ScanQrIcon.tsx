// The scan-a-pairing-code glyph: a QR code inside a camera's focus corners, on the
// Scan buttons in place of a plain camera. Feather (the app's icon set) has no QR
// glyph, so this is Lucide's scan-qr-code (lucide-react 1.17.0), drawn on the same
// 24-unit grid with Feather's 2px round strokes so it sits beside them.
//
// Lucide: ISC License, Copyright (c) 2026 Lucide Icons and Contributors. Permission
// to use, copy, modify, and/or distribute this software for any purpose with or
// without fee is hereby granted, provided that the above copyright notice and this
// permission notice appear in all copies.
import Svg, { Path, Rect } from "react-native-svg";

const PATHS = [
	"M17 12v4a1 1 0 0 1-1 1h-4",
	"M17 3h2a2 2 0 0 1 2 2v2",
	"M17 8V7",
	"M21 17v2a2 2 0 0 1-2 2h-2",
	"M3 7V5a2 2 0 0 1 2-2h2",
	"M7 17h.01",
	"M7 21H5a2 2 0 0 1-2-2v-2",
];

export function ScanQrIcon({ size, color }: { size: number; color: string }) {
	return (
		<Svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			// Decorative: every button it sits in has its own label.
			accessible={false}
		>
			{PATHS.map((d) => (
				<Path key={d} d={d} />
			))}
			<Rect x={7} y={7} width={5} height={5} rx={1} />
		</Svg>
	);
}
