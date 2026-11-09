import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { Connection } from "./connection";
import { C } from "./theme";

/** Keep the app in front while its loopback tunnel is in use. A fresh connection
 * gets a fresh URL after suspension; never retain a dead local listening port. */
export function SSHPreview({
	connection,
	port,
	onClose,
}: {
	connection: Connection | null | undefined;
	port: number;
	onClose(): void;
}) {
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		setUrl(null);
		setError(null);
		void connection?.httpUrl?.(port).then(
			(url) => {
				if (live) setUrl(url);
			},
			(e) => {
				if (live) setError(String(e));
			},
		);
		return () => {
			live = false;
		};
	}, [connection, port]);
	return (
		<Modal visible animationType="slide" onRequestClose={onClose}>
			<View style={{ flex: 1, backgroundColor: C.bg, paddingTop: 60 }}>
				<Pressable onPress={onClose} accessibilityRole="button" style={{ padding: 18 }}>
					<Text style={{ color: C.ink }}>‹ Close preview · port {port}</Text>
				</Pressable>
				{url ? (
					<WebView
						source={{ uri: url }}
						style={{ flex: 1 }}
						originWhitelist={["http://*", "https://*"]}
					/>
				) : (
					<Text style={{ color: C.muted, padding: 18 }}>{error ?? "Reconnecting to the box…"}</Text>
				)}
			</View>
		</Modal>
	);
}
