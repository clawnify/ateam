// Add a project to the BOX. Three intents, asked up front, because the engine runs
// on a machine with no Finder: bring a repo over from GitHub, use one already cloned
// there, or start something new.
//
// The fork is deliberately at INTENT rather than at "pick a folder, and if it isn't a
// repo, offer to init it". A screen whose only prominent action was "New" got used to
// mean "add", which git-inits an empty repo that someone then grafts a real one onto
// (`remote add` + `reset --hard origin/main`). That leaves a repo with no origin,
// which is the one state that can never be merged with its copies on other engines.
// So cloning is a first-class door, and "new" offers to create the GitHub repo too.

import type { DirListingDTO, ProjectDTO, RemoteRepoDTO } from "@ateam/protocol";
import { boxSupports } from "@ateam/protocol";
import { useCallback, useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	View,
} from "react-native";
import type { Connection } from "./connection";

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

type Mode = "menu" | "github" | "browse";

export function ProjectBrowser({
	conn,
	onClose,
	onRegistered,
}: {
	conn: Connection;
	onClose: () => void;
	onRegistered: (project: ProjectDTO) => void;
}) {
	const api = conn.api;
	// A pre-v9 box has no repo list and silently ignores `createRemote`, so those two
	// doors are replaced by ones that work on any box rather than shown half-broken.
	const canGithub = boxSupports("githubProjects", conn.info.protocolVersion);

	const [mode, setMode] = useState<Mode>("menu");
	const [listing, setListing] = useState<DirListingDTO | null>(null);
	const [repos, setRepos] = useState<RemoteRepoDTO[] | null>(null);
	const [filter, setFilter] = useState("");
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

	const loadRepos = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setRepos(await conn.box.repos());
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	}, [conn]);

	// Each door loads its own list the first time it opens, so the menu itself costs
	// nothing: a box with no `gh` never pays for a repo query it won't show.
	useEffect(() => {
		if (mode === "browse" && !listing) void load();
		if (mode === "github" && canGithub && !repos) void loadRepos();
	}, [mode, listing, repos, canGithub, load, loadRepos]);

	const register = useCallback(
		async (path: string) => {
			setBusyPath(path);
			setError(null);
			try {
				onRegistered(await api.projects.register(path));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyPath(null);
			}
		},
		[api, onRegistered],
	);

	// Clone it onto the box and register it in one call. Idempotent: a repo already
	// cloned there is just registered, so tapping the same row twice is harmless.
	const cloneRepo = useCallback(
		async (cloneUrl: string) => {
			setBusyPath(cloneUrl);
			setError(null);
			try {
				onRegistered(await conn.box.clone(cloneUrl));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusyPath(null);
			}
		},
		[conn, onRegistered],
	);

	const cloneByUrl = useCallback(() => {
		Alert.prompt("Clone a repo", "Paste its git URL", (url) => {
			const clean = (url ?? "").trim();
			if (clean) void cloneRepo(clean);
		});
	}, [cloneRepo]);

	// Create the folder, `git init` it, and offer to give it a GitHub origin in the
	// same call. Without a remote the project can't be merged with a copy on another
	// engine and can't be provisioned onto a second box, so the offer is the whole
	// point of asking — but "no remote" stays a real answer for a scratch project.
	const startNew = useCallback(() => {
		Alert.prompt("New project", "Name it", (name) => {
			const clean = (name ?? "").trim().replace(/^\/+|\/+$/g, "");
			if (!clean || clean.includes("/") || clean === "." || clean === "..") {
				setError("Enter a name — no slashes.");
				return;
			}
			const create = async (createRemote?: { name: string; private: boolean }) => {
				setBusyPath(clean);
				setError(null);
				try {
					// Where it goes: the folder you were browsing, else the box's home
					// (what fs.listDir answers with no argument). Resolved here rather
					// than defaulted to "~", which the engine would mkdir as a folder
					// literally named "~".
					const dir = listing?.path ?? (await api.fs.listDir()).path;
					const path = `${dir.replace(/\/$/, "")}/${clean}`;
					const project = await api.projects.register(path, { init: true, createRemote });
					if (createRemote && !project.githubOwner) {
						setError(`Created "${clean}", but GitHub refused the repo — it has no remote yet.`);
					}
					onRegistered(project);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusyPath(null);
				}
			};
			if (!canGithub) {
				void create();
				return;
			}
			Alert.alert(
				"Create it on GitHub?",
				"A project with no remote can't be shared with your Mac or another box.",
				[
					{ text: "Private repo", onPress: () => void create({ name: clean, private: true }) },
					{ text: "Public repo", onPress: () => void create({ name: clean, private: false }) },
					{ text: "No remote", style: "cancel", onPress: () => void create() },
				],
			);
		});
	}, [api, listing?.path, canGithub, onRegistered]);

	const shown = (repos ?? []).filter((r) =>
		filter ? r.fullName.toLowerCase().includes(filter.toLowerCase()) : true,
	);

	const heading = mode === "github" ? "From GitHub" : mode === "browse" ? "On the box" : null;

	return (
		<View style={styles.root}>
			<View style={styles.header}>
				<Pressable onPress={mode === "menu" ? onClose : () => setMode("menu")} hitSlop={8}>
					<Text style={styles.cancel}>{mode === "menu" ? "Cancel" : "Back"}</Text>
				</Pressable>
				<Text style={styles.title}>{heading ?? "Add project"}</Text>
				<Text style={styles.cancel} />
			</View>

			{error ? <Text style={styles.err}>{error}</Text> : null}

			{mode === "menu" ? (
				<ScrollView contentContainerStyle={styles.listContent}>
					<Choice
						label="Bring one over from GitHub"
						detail={
							canGithub
								? "Clone one of your repos onto this box"
								: "Paste a git URL (this box is too old to list your repos)"
						}
						onPress={() => (canGithub ? setMode("github") : cloneByUrl())}
					/>
					<Choice
						label="Use a repo already on the box"
						detail="Browse the box's folders for one that's cloned"
						onPress={() => setMode("browse")}
					/>
					<Choice
						label="Start something new"
						detail={
							canGithub
								? "Create a folder, git init it, and optionally a GitHub repo"
								: "Create a folder and git init it"
						}
						onPress={startNew}
					/>
				</ScrollView>
			) : mode === "github" ? (
				<>
					<TextInput
						style={styles.filter}
						value={filter}
						onChangeText={setFilter}
						placeholder="Filter repos"
						placeholderTextColor={C.faint}
						autoCapitalize="none"
						autoCorrect={false}
					/>
					{loading && !repos ? (
						<View style={styles.center}>
							<ActivityIndicator color={C.ink} />
						</View>
					) : (
						<ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
							{shown.length === 0 ? (
								<Text style={styles.empty}>
									{repos?.length ? "no match" : "no repos — is gh signed in on this box?"}
								</Text>
							) : (
								shown.map((r) => (
									<Pressable
										key={r.fullName}
										style={styles.row}
										onPress={() => cloneRepo(r.cloneUrl)}
										disabled={busyPath === r.cloneUrl}
									>
										<Text style={styles.folder}>{r.private ? "●" : "○"}</Text>
										<Text style={styles.name} numberOfLines={1}>
											{r.fullName}
										</Text>
										{busyPath === r.cloneUrl ? (
											<ActivityIndicator color={C.ink} size="small" />
										) : null}
									</Pressable>
								))
							)}
						</ScrollView>
					)}
					<Pressable onPress={cloneByUrl} hitSlop={8}>
						<Text style={styles.hint}>● private · ○ public · or paste a git URL</Text>
					</Pressable>
				</>
			) : (
				<>
					<Text style={styles.path} numberOfLines={1}>
						{listing?.path ?? "…"}
					</Text>
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
				</>
			)}
		</View>
	);
}

function Choice({
	label,
	detail,
	onPress,
}: {
	label: string;
	detail: string;
	onPress: () => void;
}) {
	return (
		<Pressable style={styles.choice} onPress={onPress}>
			<Text style={styles.choiceLabel}>{label}</Text>
			<Text style={styles.choiceDetail}>{detail}</Text>
		</Pressable>
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
	filter: {
		color: C.ink,
		backgroundColor: C.sunken,
		fontSize: 15,
		marginHorizontal: 16,
		marginVertical: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
		borderRadius: 8,
	},
	err: { color: C.red, fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
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
	choice: {
		paddingHorizontal: 16,
		paddingVertical: 18,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	choiceLabel: { color: C.ink, fontSize: 16, fontWeight: "600" },
	choiceDetail: { color: C.faint, fontSize: 13, paddingTop: 4 },
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
