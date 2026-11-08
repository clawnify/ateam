// Reads the pairing QR a Mac shows (Settings → Boxes → Pair a phone) with the
// phone's camera, inside Ateam Go: people look for the camera in the app, and the
// dev build never receives the `ateamgo://` link the iPhone's Camera opens.
// App.tsx loads this file only when asked: a build made before the camera's native
// code was added fails on importing expo-camera, and the rest of the app mustn't.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { parsePairLinks } from "./pair-link";
import { C } from "./theme";

export function PairScanner({
	onScanned,
	onClose,
}: {
	/** A pairing link was read; the scanner is done with it. */
	onScanned: (url: string) => void;
	onClose: () => void;
}) {
	// Asks for the camera at once: opening the scanner is the request.
	const [permission, requestPermission] = useCameraPermissions({ request: true });
	const [notOurs, setNotOurs] = useState(false);
	const [open, setOpen] = useState(true);
	// How it ended (a link, or null for Close), told once the modal is gone: an alert
	// asked for while it is still going away never shows on iOS.
	const result = useRef<string | null>(null);
	const ended = useRef(false);
	const told = useRef(false);
	const tell = () => {
		if (told.current) return;
		told.current = true;
		if (result.current) onScanned(result.current);
		else onClose();
	};
	const end = (url: string | null) => {
		if (ended.current) return;
		ended.current = true;
		result.current = url;
		setOpen(false);
		if (Platform.OS !== "ios") tell();
	};

	const hint = !permission
		? null
		: permission.granted
			? notOurs
				? "That isn't a code from Ateam. Point at the one under Pair your iPhone."
				: "Point it at the code in Ateam on your Mac: Settings → Boxes → Pair your iPhone."
			: permission.canAskAgain
				? "Ateam Go needs the camera to read the code."
				: "Camera access is off for Ateam Go. Turn it on in Settings, or type the code instead.";

	return (
		<Modal
			visible={open}
			animationType="slide"
			presentationStyle="fullScreen"
			onRequestClose={() => end(null)}
			onDismiss={tell}
		>
			<View style={styles.root}>
				{permission?.granted ? (
					<CameraView
						style={StyleSheet.absoluteFill}
						facing="back"
						barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
						onBarcodeScanned={({ data }) => {
							if (ended.current) return;
							if (!parsePairLinks(data)) {
								setNotOurs(true);
								return;
							}
							end(data);
						}}
					/>
				) : null}
				<View style={styles.top}>
					<Text style={styles.title}>Scan the pairing code</Text>
					{hint ? <Text style={styles.hint}>{hint}</Text> : null}
					{permission && !permission.granted ? (
						<Pressable
							style={styles.button}
							onPress={() =>
								void (permission.canAskAgain ? requestPermission() : Linking.openSettings())
							}
							accessibilityRole="button"
						>
							<Text style={styles.buttonText}>
								{permission.canAskAgain ? "Allow the camera" : "Open Settings"}
							</Text>
						</Pressable>
					) : null}
				</View>
				<Pressable
					style={styles.close}
					onPress={() => end(null)}
					hitSlop={8}
					accessibilityRole="button"
					accessibilityLabel="Close the scanner"
				>
					<Text style={styles.closeText}>Close</Text>
				</Pressable>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg },
	top: {
		paddingTop: 60,
		paddingHorizontal: 20,
		paddingBottom: 16,
		gap: 8,
		backgroundColor: "rgba(12,12,14,0.72)",
	},
	title: { color: C.ink, fontSize: 17, fontWeight: "700" },
	hint: { color: C.muted, fontSize: 14, lineHeight: 20 },
	button: {
		alignSelf: "flex-start",
		marginTop: 4,
		height: 36,
		paddingHorizontal: 14,
		borderRadius: 8,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	buttonText: { color: C.bg, fontSize: 14, fontWeight: "600" },
	close: {
		position: "absolute",
		bottom: 48,
		alignSelf: "center",
		height: 44,
		paddingHorizontal: 22,
		borderRadius: 22,
		backgroundColor: "rgba(12,12,14,0.72)",
		borderWidth: 1,
		borderColor: C.line,
		alignItems: "center",
		justifyContent: "center",
	},
	closeText: { color: C.ink, fontSize: 15, fontWeight: "600" },
});
