import { expect, test } from "bun:test";
import { attachmentName } from "./lead-attach";

test("a library photo handed over as JPEG is named .jpg, whatever its original name", () => {
	expect(
		attachmentName({ fileName: "IMG_1234.HEIC", mimeType: "image/jpeg", uri: "file:///x/abc.jpg" }),
	).toBe("IMG_1234.jpg");
});

test("a screenshot keeps its own type", () => {
	expect(
		attachmentName({ fileName: "Screenshot 1.PNG", mimeType: "image/png", uri: "file:///x/y.png" }),
	).toBe("Screenshot 1.png");
});

test("no name and no type: a dated stem and the uri's extension", () => {
	expect(attachmentName({ uri: "file:///tmp/ABC.WEBP" }, 42)).toBe("photo-42.webp");
	expect(attachmentName({ fileName: null, uri: "file:///tmp/blob" }, 42)).toBe("photo-42.jpg");
});
