// Naming a photo attached in the Lead chat. The Lead's agent opens it with
// Claude Code's Read, which goes by the file's extension, so the name has to say
// what the bytes are: the picker hands a library photo over as JPEG
// ("compatible" mode), but its fileName keeps the original "IMG_1234.HEIC".
// Pure, no React Native imports, so it runs under bun test.

const MIME_EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/heic": "heic",
	"image/tiff": "tiff",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

export function attachmentName(
	asset: { fileName?: string | null; mimeType?: string | null; uri: string },
	now = Date.now(),
): string {
	const ext =
		(asset.mimeType && MIME_EXT[asset.mimeType.toLowerCase()]) ??
		asset.uri.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ??
		"jpg";
	const stem = asset.fileName?.replace(/\.[^.]*$/, "").trim() || `photo-${now}`;
	return `${stem}.${ext}`;
}
