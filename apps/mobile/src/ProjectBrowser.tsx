// Add a project by browsing the BOX's filesystem (not the phone's) — the engine
// runs remotely, so we navigate its dirs via fs.listDir (each entry flagged if it
// holds a .git) and register a repo with projects.register. Same remote folder-pick
// the desktop uses; here it's a simple navigable list starting at the box's home.

import type { AteamApi, DirListingDTO, ProjectDTO } from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";

const C = {
	bg: "#0c0c0e",
	surface: "#141418",
	sunken: "#1c1c22",
	line: "#2a2a33",
	ink: "#e6e6ea",
	muted: "#9a9aa6",
	faint: "#6a6a75",
	green: "#4ade80",
	red: "#f87171",
};

export function ProjectBrowser({
	api,
	visible,
	onClose,
	onRegistered,
}: {
	api: AteamApi;
	visible: boolean;
	onClose: () => void;
	onRegistered: (project: ProjectDTO) => void;
}) {
	const [listing, setListing] = useState<DirListingDTO | null>(null);
	const [loading, setLoading] = useState(false);
	const [busyPath, setBusyPath] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(
		async (path?: string) => {
			setLoading(true);
			setError(null);
			try {
				setListing(await api.fs.listDir(path));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[api],
	);

	// Start at the box's home dir when the browser opens.
	useEffect(() => {
		if (visible) void load();
	}, [visible, load]);

	const register = useCallback(
		async (path: string) => {
			setBusyPath(path);
			setError(null);
			try {
				const project = await api.projects.register(path);
				onRegistered(project);
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyPath(null);
			}
		},
		[api, onRegistered],
	);

	return (
		<Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
			<View style={styles.root}>
				<View style={styles.header}>
					<Pressable onPress={onClose} hitSlop={8}>
						<Text style={styles.cancel}>Cancel</Text>
					</Pressable>
					<Text style={styles.title}>Add project</Text>
					<View style={{ width: 54 }} />
				</View>

				<Text style={styles.path} numberOfLines={1}>
					{listing?.path ?? "…"}
				</Text>

				{error ? <Text style={styles.err}>{error}</Text> : null}

				{loading && !listing ? (
					<View style={styles.center}>
						<ActivityIndicator color={C.ink} />
					</View>
				) : (
					<ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
						{listing?.parent ? (
							<Pressable style={styles.row} onPress={() => load(listing.parent ?? undefined)}>
								<Text style={styles.up}>‹</Text>
								<Text style={styles.name}>..</Text>
							</Pressable>
						) : null}
						{listing?.entries.length === 0 ? (
							<Text style={styles.empty}>no subfolders</Text>
						) : (
							listing?.entries.map((e) => (
								<Pressable key={e.path} style={styles.row} onPress={() => load(e.path)}>
									<Text style={styles.folder}>{e.isRepo ? "◆" : "▸"}</Text>
									<Text style={styles.name} numberOfLines={1}>
										{e.name}
									</Text>
									{e.isRepo ? (
										<Pressable
											style={styles.addBtn}
											onPress={() => register(e.path)}
											disabled={busyPath === e.path}
											hitSlop={6}
										>
											{busyPath === e.path ? (
												<ActivityIndicator color="#15151a" size="small" />
											) : (
												<Text style={styles.addText}>Add</Text>
											)}
										</Pressable>
									) : null}
								</Pressable>
							))
						)}
					</ScrollView>
				)}
				<Text style={styles.hint}>◆ = a git repo you can add · tap a folder to open it</Text>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	header: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingHorizontal: 16,
		paddingBottom: 12,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	cancel: { color: C.muted, fontSize: 15, width: 54 },
	title: { color: C.ink, fontSize: 16, fontWeight: "700" },
	path: {
		color: C.faint,
		fontSize: 12,
		paddingHorizontal: 16,
		paddingVertical: 10,
		fontVariant: ["tabular-nums"],
	},
	err: { color: C.red, fontSize: 13, paddingHorizontal: 16, paddingBottom: 8 },
	center: { flex: 1, alignItems: "center", justifyContent: "center" },
	list: { flex: 1 },
	listContent: { paddingBottom: 40 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 16,
		paddingVertical: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	up: { color: C.muted, fontSize: 18, width: 16, textAlign: "center" },
	folder: { color: C.muted, fontSize: 14, width: 16, textAlign: "center" },
	name: { color: C.ink, fontSize: 15, flex: 1 },
	addBtn: {
		backgroundColor: C.green,
		paddingHorizontal: 14,
		paddingVertical: 6,
		borderRadius: 7,
		minWidth: 52,
		alignItems: "center",
	},
	addText: { color: "#15151a", fontSize: 13, fontWeight: "800" },
	empty: { color: C.faint, fontSize: 13, textAlign: "center", paddingVertical: 24 },
	hint: {
		color: C.faint,
		fontSize: 11,
		textAlign: "center",
		paddingVertical: 12,
		paddingHorizontal: 16,
	},
});
