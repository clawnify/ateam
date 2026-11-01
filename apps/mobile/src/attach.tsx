// Files attached from the phone (photos, or any file from Files) to a new
// task's agent or to a message for the box's Lead. They are picked first and
// held on the phone, then uploaded when the message goes, to where it goes: the
// task's box (util.writeImageBytes, any bytes, the path its agent reads) or the
// Lead's own folder (lead:attachBytes). So the board composer's Task/Lead switch
// can change after a file is picked.
import type { AteamApi, LeadClient, LeadEvent } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import {
	ActionSheetIOS,
	Alert,
	Image,
	Platform,
	Pressable,
	ScrollView,
	type StyleProp,
	StyleSheet,
	Text,
	View,
	type ViewStyle,
} from "react-native";
import { attachmentName } from "./lead-attach";
import { C } from "./theme";

export interface PickedFile {
	name: string;
	base64: string;
	/** On this phone, for the preview. */
	uri: string;
	/** Shown as a thumbnail rather than a chip. */
	image: boolean;
}

/** A file over this is refused: the desktop's cap for a box (deliver-files.ts),
 *  since a big upload holds up everything else on the box's connection. */
export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;
const MAX_LABEL = "10 MB";

/** Previews by the path a photo got on the box, for the Lead chat's bubbles of
 *  messages sent from this phone since it started. */
export const previews = new Map<string, string>();

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?|avif)$/i;
const bytesOf = (base64: string) => Math.floor((base64.length * 3) / 4);

export interface Picked {
	files: PickedFile[];
	/** What was left out, and why, for the composer to say. */
	note: string | null;
}

const NOTHING: Picked = { files: [], note: null };

const tooBig = (names: string[]) =>
	names.length ? `Over ${MAX_LABEL}, left out: ${names.join(", ")}.` : null;

/** Up to five photos from the library. */
export async function pickPhotos(): Promise<Picked> {
	const res = await ImagePicker.launchImageLibraryAsync({
		mediaTypes: ["images"],
		base64: true,
		quality: 0.7,
		allowsMultipleSelection: true,
		selectionLimit: 5,
		// JPEG rather than HEIC: an agent can read a JPEG (lead-attach.ts).
		preferredAssetRepresentationMode:
			ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
	});
	if (res.canceled) return NOTHING;
	const files: PickedFile[] = [];
	const big: string[] = [];
	for (const a of res.assets) {
		if (!a.base64) continue;
		const name = attachmentName(a);
		if (bytesOf(a.base64) > MAX_ATTACH_BYTES) big.push(name);
		else files.push({ name, base64: a.base64, uri: a.uri, image: true });
	}
	return { files, note: tooBig(big) };
}

/** Any files, from Files (iCloud Drive, On My iPhone, other apps' providers). */
export async function pickFiles(): Promise<Picked> {
	const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
	if (res.canceled) return NOTHING;
	const files: PickedFile[] = [];
	const big: string[] = [];
	for (const a of res.assets) {
		// Checked before reading it in, when the picker knows the size.
		if ((a.size ?? 0) > MAX_ATTACH_BYTES) {
			big.push(a.name);
			continue;
		}
		const base64 = await new File(a.uri).base64();
		if (bytesOf(base64) > MAX_ATTACH_BYTES) big.push(a.name);
		else
			files.push({
				name: a.name,
				base64,
				uri: a.uri,
				image: Boolean(a.mimeType?.startsWith("image/")) || IMAGE_EXT.test(a.name),
			});
	}
	return { files, note: tooBig(big) };
}

/** The paperclip: photos or files. Resolves with nothing when the user cancels. */
export function chooseAttachments(): Promise<Picked> {
	return new Promise((resolve) => {
		const run = (pick: () => Promise<Picked>) =>
			pick().then(resolve, (e) =>
				resolve({ files: [], note: e instanceof Error ? e.message : String(e) }),
			);
		const options = ["Photo Library", "Files"];
		if (Platform.OS === "ios") {
			ActionSheetIOS.showActionSheetWithOptions(
				{ options: [...options, "Cancel"], cancelButtonIndex: 2 },
				(i) => (i === 0 ? run(pickPhotos) : i === 1 ? run(pickFiles) : resolve(NOTHING)),
			);
			return;
		}
		Alert.alert("Attach", undefined, [
			{ text: options[0], onPress: () => run(pickPhotos) },
			{ text: options[1], onPress: () => run(pickFiles) },
			{ text: "Cancel", style: "cancel", onPress: () => resolve(NOTHING) },
		]);
	});
}

/** Into the Lead's folder on the box: the paths to send with the message. */
export async function filesToLead(lead: LeadClient, files: PickedFile[]): Promise<string[]> {
	const paths: string[] = [];
	for (const f of files) {
		const file = await lead.attachBytes(f.name, f.base64);
		if (f.image) previews.set(file.path, f.uri);
		paths.push(file.path);
	}
	return paths;
}

/** Onto the box for a task's agent: the paths to start it with. The engine
 *  keeps the extension, which is how an agent tells what a file is. */
export async function filesToBox(api: AteamApi, files: PickedFile[]): Promise<string[]> {
	const paths: string[] = [];
	for (const f of files) {
		const ext = f.name.includes(".") ? (f.name.split(".").pop() ?? "") : "";
		paths.push(await api.utils.writeImageBytes(f.base64, ext || "bin"));
	}
	return paths;
}

/** The box Lead's Auto switch, for a composer outside the chat. Reads the
 *  state only while `active`, since that asks the box for the conversation. */
export function useLeadAuto(lead: LeadClient | undefined, active: boolean): [boolean, () => void] {
	const [auto, setAuto] = useState(false);
	useEffect(() => {
		if (!lead || !active) return;
		let live = true;
		const off = lead.onEvent((e: LeadEvent) => {
			if (e.type === "auto") setAuto(e.auto);
			else if (e.type === "reset") setAuto(e.snapshot.auto);
		});
		lead.snapshot().then(
			(s) => live && setAuto(s.auto),
			() => {},
		);
		return () => {
			live = false;
			off();
		};
	}, [lead, active]);
	const toggle = () => {
		if (!lead) return;
		const next = !auto;
		setAuto(next);
		void lead.setAuto(next).catch(() => setAuto(!next));
	};
	return [auto, toggle];
}

/** The files waiting to go, each with a remove button: photos as thumbnails,
 *  anything else as a named chip. */
export function AttachmentStrip({
	files,
	onRemove,
	style,
}: {
	files: PickedFile[];
	onRemove: (file: PickedFile) => void;
	/** Where it sits: the space to what is around it is the caller's. */
	style?: StyleProp<ViewStyle>;
}) {
	if (!files.length) return null;
	return (
		<ScrollView horizontal style={[styles.strip, style]} contentContainerStyle={styles.row}>
			{files.map((f) => (
				<View key={f.uri}>
					{f.image ? (
						<Image source={{ uri: f.uri }} style={styles.thumb} />
					) : (
						<View style={styles.chip}>
							<Feather name="file" size={13} color={C.muted} />
							<Text style={styles.chipText} numberOfLines={1}>
								{f.name}
							</Text>
						</View>
					)}
					<Pressable
						style={styles.remove}
						onPress={() => onRemove(f)}
						hitSlop={8}
						accessibilityLabel={`Remove ${f.name}`}
					>
						<Feather name="x" size={11} color="#15151a" />
					</Pressable>
				</View>
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	strip: { flexGrow: 0 },
	row: { gap: 10, paddingTop: 6, paddingRight: 6, alignItems: "center" },
	thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: C.sunken },
	chip: {
		flexDirection: "row",
		alignItems: "center",
		gap: 6,
		maxWidth: 180,
		height: 40,
		paddingHorizontal: 10,
		borderRadius: 8,
		backgroundColor: C.sunken,
	},
	chipText: { color: C.ink, fontSize: 13, flexShrink: 1 },
	remove: {
		position: "absolute",
		top: -4,
		right: -4,
		width: 18,
		height: 18,
		borderRadius: 9,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
});
