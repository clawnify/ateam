// Create a box on Hetzner, from the phone (src/useBoxCreation.ts holds the creation
// itself, so leaving this page doesn't stop it). The form asks for the two keys the
// box needs, each with the page it's made on, then a name, a place and a size, with
// what Hetzner bills for them. Then it shows the box coming up, with a way to reach
// it by address when its name doesn't resolve, and a way to delete it.
import { hetznerProvider, type ProviderOptions } from "@ateam/protocol";
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef, useState } from "react";
import {
	ActionSheetIOS,
	ActivityIndicator,
	Linking,
	Platform,
	Pressable,
	ScrollView,
	StatusBar,
	StyleSheet,
	Switch,
	Text,
	TextInput,
	View,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { sshAvailable } from "../modules/expo-ssh/src";
import { onTailnet } from "../modules/expo-tailnet/src";
import {
	AGENT_CHOICES,
	boxNameOf,
	defaultBoxName,
	defaultsOf,
	HETZNER_ACCOUNT,
	HETZNER_TOKENS_URL,
	priceLine,
	sizesIn,
	TAILSCALE_KEYS_URL,
} from "./create-box";
import { shareMacApp } from "./mac-app";
import { ProviderIcon } from "./ProviderIcon";
import { PROVIDER_LOGOS } from "./provider-logos";
import { PROVIDER_SETUPS, type ProviderSetup, type SSHSetup } from "./provider-setup";
import { loadProviderAccount, saveProviderAccount } from "./storage";
import { openTailscale, useTailnet } from "./tailnet";
import { C, CONTENT_MAX } from "./theme";
import type { CreateSpec, Creation } from "./useBoxCreation";

/** About how long a box takes from Hetzner's go to Ateam answering on it. */
/** Past this, the page says it's taking too long, and where to look. */
const SLOW_MS = 12 * 60_000;

const nameRandom = (n: number) =>
	Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256));

function Field({
	label,
	value,
	onChangeText,
	placeholder,
	secure,
	onBlur,
}: {
	label: string;
	value: string;
	onChangeText: (t: string) => void;
	placeholder: string;
	secure?: boolean;
	onBlur?: () => void;
}) {
	return (
		<View style={styles.field}>
			<Text style={styles.fieldLabel}>{label}</Text>
			<TextInput
				style={styles.fieldInput}
				value={value}
				onChangeText={onChangeText}
				onBlur={onBlur}
				placeholder={placeholder}
				placeholderTextColor={C.faint}
				autoCapitalize="none"
				autoCorrect={false}
				secureTextEntry={secure}
			/>
		</View>
	);
}

function Help({ text, link, url }: { text: string; link: string; url: string }) {
	return (
		<View style={styles.help}>
			<Text style={styles.helpText}>{text}</Text>
			<Pressable onPress={() => void Linking.openURL(url)} hitSlop={6} accessibilityRole="link">
				<Text style={styles.link}>{link}</Text>
			</Pressable>
		</View>
	);
}

/** A row that opens the system's own list to choose from (the action sheet on iOS):
 *  an inline list of a dozen sizes was hard to scroll and to hit. Elsewhere, the list
 *  opens below the row. `detail` adds a word to each choice (its price). */
/** The first step: where the box runs (src/provider-setup.ts). Only Hetzner without
 *  SSH in this build, as every other way in is SSH. */
function ProviderStep({ onPick }: { onPick: (p: ProviderSetup) => void }) {
	return (
		<View style={styles.column}>
			<Text style={styles.intro}>
				Where should your box run? Either way it gets Ateam and your coding agents.
			</Text>
			<View style={styles.choices}>
				{PROVIDER_SETUPS.filter((p) => p.creates || sshAvailable).map((p) => (
					<Pressable
						key={p.id}
						style={({ pressed }) => [styles.choice, styles.providerRow, pressed && styles.pressed]}
						onPress={() => onPick(p)}
						accessibilityRole="button"
						accessibilityLabel={`${p.label}. ${p.body}`}
					>
						<ProviderIcon providerId={p.id} size={36} />
						<View style={styles.choiceText}>
							<Text style={styles.choiceTitle}>{p.label}</Text>
							<Text style={styles.helpText}>{p.body}</Text>
						</View>
						<Feather name="chevron-right" size={16} color={C.muted} />
					</Pressable>
				))}
			</View>
		</View>
	);
}

/** A machine made at its provider: what to do there, one step at a time (side by
 *  side they read as a choice between them), then on to SSH. */
function ProviderSteps({ setup, onContinue }: { setup: ProviderSetup; onContinue: () => void }) {
	const steps = setup.steps ?? [];
	const [at, setAt] = useState(0);
	const step = steps[at];
	const last = at >= steps.length - 1;
	return (
		<View style={styles.column}>
			<View style={styles.providerHead}>
				<ProviderIcon providerId={setup.id} size={36} />
				<Text style={styles.title}>{setup.label}</Text>
			</View>
			<Text style={styles.intro}>{setup.body}</Text>
			{step ? (
				<>
					<Text style={styles.eyebrow}>
						Step {at + 1} of {steps.length}
					</Text>
					<View style={styles.card}>
						<Text style={styles.stepBody}>{step.text}</Text>
						{step.link ? (
							<Pressable
								style={({ pressed }) => [styles.stepLink, pressed && styles.pressed]}
								onPress={() => void Linking.openURL(step.link?.url ?? "")}
								accessibilityRole="link"
							>
								<Text style={styles.stepLinkText}>{step.link.label}</Text>
								<Feather name="external-link" size={14} color={C.ink} />
							</Pressable>
						) : null}
					</View>
				</>
			) : null}
			<Pressable
				style={styles.primary}
				onPress={() => (last ? onContinue() : setAt(at + 1))}
				accessibilityRole="button"
			>
				<Text style={styles.primaryText}>{last ? "Connect over SSH" : "Next"}</Text>
			</Pressable>
			{at > 0 ? (
				<Pressable onPress={() => setAt(at - 1)} hitSlop={8} accessibilityRole="button">
					<Text style={styles.stepBack}>Previous step</Text>
				</Pressable>
			) : null}
		</View>
	);
}

/** How the phone will reach the box, chosen before it exists: it's in the box's
 *  first-boot setup and its firewall. Each way is a card of its own, with why. */
function ConnectionChoice({ value, onPick }: { value: string; onPick: (slug: string) => void }) {
	const choices = [
		{
			slug: "tailscale",
			title: "Tailscale",
			body: "Recommended for security: the box takes nothing from the internet. Needs a Tailscale account.",
		},
		...(sshAvailable
			? [
					{
						slug: "ssh",
						title: "SSH",
						body: "No Tailscale account needed. Only SSH is open, and only this phone's key logs in.",
					},
				]
			: []),
	];
	return (
		<View style={styles.choices} accessibilityRole="radiogroup">
			{choices.map((c) => {
				const on = c.slug === value;
				return (
					<Pressable
						key={c.slug}
						style={({ pressed }) => [
							styles.choice,
							on && styles.choiceOn,
							pressed && styles.pressed,
						]}
						onPress={() => onPick(c.slug)}
						accessibilityRole="radio"
						accessibilityState={{ checked: on }}
						accessibilityLabel={`${c.title}. ${c.body}`}
					>
						<Feather name={on ? "check-circle" : "circle"} size={18} color={on ? C.ink : C.faint} />
						<View style={styles.choiceText}>
							<Text style={styles.choiceTitle}>{c.title}</Text>
							<Text style={styles.helpText}>{c.body}</Text>
						</View>
					</Pressable>
				);
			})}
		</View>
	);
}

function Picker<T extends { slug: string; label: string }>({
	label,
	items,
	value,
	onPick,
	detail,
}: {
	label: string;
	items: T[];
	value: string;
	onPick: (slug: string) => void;
	detail?: (item: T) => string | null;
}) {
	const [open, setOpen] = useState(false);
	const current = items.find((i) => i.slug === value);
	const shown = (i: T) => {
		const d = detail?.(i);
		return d ? `${i.label} · ${d}` : i.label;
	};
	const choose = () => {
		if (Platform.OS !== "ios") return setOpen((o) => !o);
		ActionSheetIOS.showActionSheetWithOptions(
			{ title: label, options: [...items.map(shown), "Cancel"], cancelButtonIndex: items.length },
			(i) => {
				const item = items[i];
				if (item) onPick(item.slug);
			},
		);
	};
	return (
		<View>
			<Pressable
				style={styles.field}
				onPress={choose}
				accessibilityRole="button"
				accessibilityLabel={`${label}: ${current?.label ?? "none"}`}
			>
				<Text style={styles.fieldLabel}>{label}</Text>
				<Text style={styles.pickerValue} numberOfLines={1}>
					{current?.label ?? "Pick one"} ›
				</Text>
			</Pressable>
			{open
				? items.map((i) => (
						<Pressable
							key={i.slug}
							style={styles.option}
							onPress={() => {
								setOpen(false);
								onPick(i.slug);
							}}
							accessibilityRole="button"
						>
							<Text style={styles.optionText}>{shown(i)}</Text>
							{i.slug === value ? <Feather name="check" size={15} color={C.ink} /> : null}
						</Pressable>
					))
				: null}
		</View>
	);
}

/** Where else Ateam for Mac sets a box up (docs/providers), by their marks. Not boxd,
 *  which has its own card on the first step. The last circle is any machine over SSH. */
const MORE_PROVIDERS = ["sprites"];

function LogoStack() {
	return (
		<View style={styles.stack} accessible={false} importantForAccessibility="no-hide-descendants">
			{[...MORE_PROVIDERS, null].map((id, i) => {
				const logo = id ? PROVIDER_LOGOS[id] : undefined;
				return (
					<View
						key={id ?? "any"}
						style={[styles.stackCircle, i > 0 && styles.stackOverlap, { zIndex: 10 - i }]}
					>
						{logo ? (
							<Svg width={14} height={14} viewBox={logo.viewBox}>
								<Path d={logo.d} fill={logo.fill ?? C.ink} />
							</Svg>
						) : (
							<Feather name="terminal" size={13} color={C.muted} />
						)}
					</View>
				);
			})}
		</View>
	);
}

function Step({ state, text }: { state: "done" | "active" | "waiting"; text: string }) {
	return (
		<View style={styles.step}>
			{state === "done" ? (
				<Feather name="check" size={16} color={C.green} />
			) : state === "active" ? (
				<ActivityIndicator size="small" color={C.muted} />
			) : (
				<View style={styles.stepDot} />
			)}
			<Text style={[styles.stepText, state === "waiting" && styles.stepWaiting]}>{text}</Text>
		</View>
	);
}

function Progress({
	onVerify,
	creation,
	onReachAt,
	onDelete,
	onStartOver,
}: {
	onVerify: () => void;
	creation: Creation;
	onReachAt: (host: string) => void;
	onDelete: () => void;
	onStartOver: () => void;
}) {
	const [now, setNow] = useState(Date.now());
	const [address, setAddress] = useState("");
	const tailnet = useTailnet();
	useEffect(() => {
		if (creation.step !== "installing") return;
		const t = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(t);
	}, [creation.step]);
	const made = creation.serverId !== null;
	const ran = creation.createdAt ? now - creation.createdAt : 0;
	const minutes = `${Math.floor(ran / 60_000)}:${String(Math.floor(ran / 1000) % 60).padStart(2, "0")}`;
	const installing = creation.step === "installing";
	return (
		<View style={styles.column}>
			<Text style={styles.title}>{creation.name}</Text>
			<View style={styles.card}>
				<Step
					state={made ? "done" : creation.step === "failed" ? "waiting" : "active"}
					text={made ? "Hetzner made the server" : "Hetzner is making the server"}
				/>
				<Step
					state={creation.step === "done" ? "done" : installing ? "active" : "waiting"}
					text={
						installing
							? `It's installing Ateam on itself. This can take several minutes (${minutes})`
							: "It installs Ateam on itself"
					}
				/>
				<Step
					state={creation.step === "done" ? "done" : "waiting"}
					text={
						creation.box.ssh
							? "This phone connects over SSH"
							: "This phone connects to it over Tailscale"
					}
				/>
			</View>

			{creation.error ? (
				<View style={styles.errorBox}>
					<Text style={styles.errorText}>{creation.error}</Text>
				</View>
			) : null}

			{installing && ran > SLOW_MS ? (
				<Text style={styles.warn}>
					It's taking longer than it should. In a browser, Hetzner's console shows the box's screen;
					the install's log is ateam-install.log in its home folder.
				</Text>
			) : null}

			{installing && creation.box.ssh && !creation.box.ssh.hostKey ? (
				<Pressable
					style={styles.primary}
					disabled={creation.verifying || creation.deleting}
					onPress={onVerify}
					accessibilityRole="button"
				>
					<Text style={styles.primaryText}>
						{creation.verifying ? "Checking SSH host…" : "Verify SSH host and connect"}
					</Text>
				</Pressable>
			) : null}
			{installing && !creation.box.ssh ? (
				<View style={styles.card}>
					<Text style={styles.helpText}>
						Still not connecting? Find {creation.name} in the Tailscale app, copy its address, and
						put it here.
					</Text>
					<View style={styles.addressRow}>
						<TextInput
							style={styles.addressInput}
							value={address}
							onChangeText={setAddress}
							placeholder="100.x.y.z"
							placeholderTextColor={C.faint}
							autoCapitalize="none"
							autoCorrect={false}
							keyboardType="numbers-and-punctuation"
						/>
						<Pressable
							style={[styles.smallBtn, !address.trim() && styles.disabled]}
							onPress={() => onReachAt(address)}
							disabled={!address.trim()}
							accessibilityRole="button"
						>
							<Text style={styles.smallBtnText}>Use it</Text>
						</Pressable>
					</View>
					{tailnet === false ? (
						<Pressable onPress={openTailscale} hitSlop={6} accessibilityRole="button">
							<Text style={styles.warn}>
								Tailscale is off on this phone, so it can't reach the box. Turn it on
							</Text>
						</Pressable>
					) : tailnet === null ? (
						<Pressable onPress={openTailscale} hitSlop={6} accessibilityRole="link">
							<Text style={styles.link}>No Tailscale app on this phone? Get it</Text>
						</Pressable>
					) : null}
				</View>
			) : null}

			{creation.step === "failed" && !made ? (
				<Pressable style={styles.primary} onPress={onStartOver} accessibilityRole="button">
					<Text style={styles.primaryText}>Try again</Text>
				</Pressable>
			) : null}
			{made && creation.step !== "done" ? (
				<Pressable
					style={styles.plain}
					onPress={onDelete}
					disabled={creation.deleting}
					accessibilityRole="button"
				>
					<Text style={styles.danger}>
						{creation.deleting ? "Deleting it on Hetzner…" : "Delete the server"}
					</Text>
				</Pressable>
			) : null}
			{made ? (
				<Text style={styles.note}>
					Hetzner bills it until it's deleted, here or in Hetzner's console. Keep access to your
					provider account for recovery.
				</Text>
			) : null}
		</View>
	);
}

export function CreateBoxScreen({
	creation,
	onVerify,
	onCreate,
	onReachAt,
	onDelete,
	onStartOver,
	onBack,
	onConnectOver,
}: {
	onVerify: () => void;
	creation: Creation | null;
	onCreate: (spec: CreateSpec) => void;
	onReachAt: (host: string) => void;
	onDelete: () => void;
	onStartOver: () => void;
	onBack: () => void;
	/** A machine made at a provider: the Add a box form, over SSH, set up for it. */
	onConnectOver: (setup: SSHSetup) => void;
}) {
	// Where it runs, picked on the first step; Hetzner's is the form below.
	const [picked, setPicked] = useState<ProviderSetup | null>(null);
	const pick = (p: ProviderSetup) => {
		if (p.creates || p.steps) setPicked(p);
		else if (p.ssh) onConnectOver(p.ssh);
	};
	// A saved token is only ever held here, in a ref, never in render state.
	const savedToken = useRef<string | null>(null);
	const [tokenSaved, setTokenSaved] = useState(false);
	const [token, setToken] = useState("");
	const [tsKey, setTsKey] = useState("");
	// SSH when this phone isn't on a tailnet: no Tailscale account or auth key to get
	// first. Where the build can't tell, Tailscale as before.
	const [network, setNetwork] = useState(() =>
		sshAvailable && onTailnet() === false ? "ssh" : "tailscale",
	);
	const [name, setName] = useState(() => defaultBoxName(nameRandom));
	const [options, setOptions] = useState<ProviderOptions | null>(null);
	const [location, setLocation] = useState("");
	const [size, setSize] = useState("");
	const [agentChoice, setAgentChoice] = useState("claude");
	const [browser, setBrowser] = useState(true);
	const [loading, setLoading] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// The catalog, fetched with the token: only what can really be ordered, and what it
	// costs. A typed token that works is saved for next time.
	const load = async (typed: string | null) => {
		const t = typed ?? savedToken.current;
		if (!t) return;
		setLoading(true);
		setProblem(null);
		try {
			const o = await hetznerProvider.fetchOptions(t);
			setOptions(o);
			const start = defaultsOf(o);
			setLocation(start?.location ?? "");
			setSize(start?.size ?? "");
			if (typed) {
				await saveProviderAccount(HETZNER_ACCOUNT, "token", typed);
				savedToken.current = typed;
				setTokenSaved(true);
				setToken("");
			}
		} catch (e) {
			setOptions(null);
			// Its message without the API path the shared client puts first.
			const why = (e instanceof Error ? e.message : String(e)).replace(/^Hetzner \S+: /, "");
			setProblem(`Hetzner didn't take that token: ${why}. It needs Read & Write.`);
		} finally {
			setLoading(false);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, for a saved token
	useEffect(() => {
		void loadProviderAccount(HETZNER_ACCOUNT, ["token"]).then((a) => {
			if (!a.token) return;
			savedToken.current = a.token;
			setTokenSaved(true);
			void load(null);
		});
	}, []);

	const forgetToken = () => {
		void saveProviderAccount(HETZNER_ACCOUNT, "token", null);
		savedToken.current = null;
		setTokenSaved(false);
		setOptions(null);
		setProblem(null);
	};

	const boxName = boxNameOf(name);
	const keyOk = /^tskey-auth-[A-Za-z0-9-]+$/.test(tsKey.trim());
	const sizes = options ? sizesIn(options, location) : [];
	const browserSupported =
		options?.serverTypes.find((s) => s.slug === size)?.architecture !== "arm";
	const price = options && size && location ? priceLine(options, size, location) : null;
	const ready = Boolean(
		savedToken.current && options && boxName && (network === "ssh" || keyOk) && size && location,
	);

	return (
		<View style={styles.root}>
			<StatusBar barStyle="light-content" backgroundColor={C.bg} />
			<View style={styles.navBar}>
				{/* Back to the providers from one picked; off the page from the first step. */}
				<Pressable
					onPress={() => (picked && !creation ? setPicked(null) : onBack())}
					hitSlop={8}
					accessibilityRole="button"
				>
					<Text style={styles.backText}>‹ Back</Text>
				</Pressable>
				<Text style={styles.navTitle}>Create a box</Text>
			</View>
			<ScrollView
				contentContainerStyle={styles.content}
				keyboardShouldPersistTaps="handled"
				showsVerticalScrollIndicator={false}
			>
				{creation ? (
					<Progress
						onVerify={onVerify}
						creation={creation}
						onReachAt={onReachAt}
						onDelete={onDelete}
						onStartOver={onStartOver}
					/>
				) : !picked ? (
					<ProviderStep onPick={pick} />
				) : !picked.creates ? (
					<ProviderSteps
						setup={picked}
						onContinue={() => {
							if (picked.ssh) onConnectOver(picked.ssh);
						}}
					/>
				) : (
					<View style={styles.column}>
						<Text style={styles.intro}>
							A server of your own on Hetzner Cloud. It installs Ateam and your coding agents.
							Connect using Tailscale or a device SSH key, then sign in from its terminal.
						</Text>

						<Text style={styles.eyebrow}>Hetzner</Text>
						<View style={styles.card}>
							{tokenSaved ? (
								<View style={styles.savedRow}>
									<Text style={styles.helpText}>API token saved on this phone.</Text>
									<Pressable onPress={forgetToken} hitSlop={6} accessibilityRole="button">
										<Text style={styles.link}>Use another</Text>
									</Pressable>
								</View>
							) : (
								<>
									<Field
										label="API token"
										value={token}
										onChangeText={setToken}
										onBlur={() => token.trim() && void load(token.trim())}
										placeholder="Paste your token"
										secure
									/>
									<Help
										text="In the Hetzner Console, open a project, then Security, API tokens, Generate API token, with Read & Write. Hetzner shows it once."
										link="Open the Hetzner Console"
										url={HETZNER_TOKENS_URL}
									/>
								</>
							)}
							{loading ? <Text style={styles.helpText}>Checking it with Hetzner…</Text> : null}
							{problem ? <Text style={styles.errorText}>{problem}</Text> : null}
						</View>

						<Text style={styles.eyebrow}>Connection</Text>
						<ConnectionChoice value={network} onPick={setNetwork} />
						{network === "ssh" ? (
							<Text style={styles.helpText}>
								Ateam generates the key on this phone and installs its public half on the server.
								Keep your provider account for recovery if you lose this phone.
							</Text>
						) : (
							<>
								<Text style={styles.eyebrow}>Tailscale</Text>
								<View style={styles.card}>
									<Field
										label="Auth key"
										value={tsKey}
										onChangeText={setTsKey}
										placeholder="tskey-auth-…"
										secure
									/>
									<Help
										text="In Tailscale's admin console, Settings, Keys, Generate auth key. Leave Reusable off: the box can read its key back, so one that works once is safest. Turn on Pre-approved if your tailnet approves devices."
										link="Open Tailscale's keys"
										url={TAILSCALE_KEYS_URL}
									/>
									{tsKey.trim() && !keyOk ? (
										<Text style={styles.errorText}>An auth key starts with tskey-auth-.</Text>
									) : null}
								</View>
							</>
						)}
						{options ? (
							<>
								<Text style={styles.eyebrow}>Box</Text>
								<View style={styles.card}>
									<Field label="Name" value={name} onChangeText={setName} placeholder="ateam-box" />
									<Picker
										label="Where"
										items={options.locations}
										value={location}
										onPick={(l) => {
											setLocation(l);
											const fits = sizesIn(options, l);
											if (!fits.some((t) => t.slug === size)) {
												setSize((fits.find((t) => t.memory >= 4) ?? fits[0])?.slug ?? "");
											}
										}}
									/>
									<Picker
										label="Agent"
										items={AGENT_CHOICES}
										value={agentChoice}
										onPick={setAgentChoice}
									/>
									<View style={styles.field}>
										<Text style={[styles.fieldLabel, { flex: 1 }]}>
											{browserSupported ? "Include browser" : "Browser requires an x86 size"}
										</Text>
										<Switch
											value={browser && browserSupported}
											disabled={!browserSupported}
											onValueChange={setBrowser}
											accessibilityLabel="Include browser for web tasks"
										/>
									</View>
									<Picker
										label="Size"
										items={sizes}
										value={size}
										onPick={setSize}
										detail={(t) => {
											const m = t.monthly?.[location];
											return m === undefined
												? null
												: `${m.toFixed(2)}${options.currency ? ` ${options.currency}` : ""} a month`;
										}}
									/>
								</View>
								{price ? <Text style={styles.price}>{price}, billed by Hetzner.</Text> : null}
							</>
						) : null}

						<Pressable
							style={[styles.primary, !ready && styles.disabled]}
							disabled={!ready}
							onPress={() => {
								const t = savedToken.current;
								if (!t || !boxName) return;
								onCreate({
									network: network === "ssh" ? "ssh" : "tailscale",
									token: t,
									tailscaleAuthKey: tsKey.trim(),
									name: boxName,
									size,
									location,
									agents: AGENT_CHOICES.find((c) => c.slug === agentChoice)?.agents ?? [],
									browser: browser && browserSupported,
								});
							}}
							accessibilityRole="button"
						>
							<Text style={styles.primaryText}>Create the box</Text>
						</Pressable>
						<Text style={styles.note}>
							Ateam Go sends your token and the box's settings to Hetzner, and the key to the box.
							None of it goes to us: we run no server.
						</Text>
						{/* Hetzner is the one provider the phone creates boxes on; the Mac sets up any. */}
						<Pressable
							style={({ pressed }) => [styles.more, pressed && styles.pressed]}
							onPress={shareMacApp}
							accessibilityRole="button"
							accessibilityLabel="More ways to get a box"
						>
							<LogoStack />
							<View style={styles.moreText}>
								<Text style={styles.moreTitle}>More ways to get a box</Text>
								<Text style={styles.moreBody}>
									Already have a Linux server? Use Add a box and choose SSH. Ateam for Mac can also
									set up remote machines.
								</Text>
							</View>
							<Feather name="chevron-right" size={16} color={C.muted} />
						</Pressable>
					</View>
				)}
			</ScrollView>
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: C.bg, paddingTop: 60 },
	navBar: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		paddingHorizontal: 18,
		paddingBottom: 14,
		borderBottomWidth: 1,
		borderBottomColor: C.line,
	},
	backText: { color: C.ink, fontSize: 16 },
	navTitle: { color: C.ink, fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
	content: { padding: 16, paddingTop: 20, paddingBottom: 60 },
	column: { width: "100%", maxWidth: CONTENT_MAX, alignSelf: "center", gap: 10 },
	intro: { color: C.muted, fontSize: 14, lineHeight: 20 },
	title: { color: C.ink, fontSize: 20, fontWeight: "700" },
	eyebrow: {
		color: C.faint,
		fontSize: 11,
		fontWeight: "700",
		letterSpacing: 0.6,
		textTransform: "uppercase",
		marginTop: 8,
	},
	card: {
		gap: 10,
		padding: 14,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	field: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 36 },
	fieldLabel: { color: C.muted, fontSize: 14, width: 80 },
	fieldInput: { flex: 1, color: C.ink, fontSize: 15, paddingVertical: 6 },
	pickerValue: { flex: 1, color: C.ink, fontSize: 15, textAlign: "right" },
	option: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingVertical: 9,
		paddingLeft: 92,
	},
	optionText: { color: C.ink, fontSize: 14, flexShrink: 1 },
	help: { gap: 6 },
	helpText: { color: C.muted, fontSize: 13, lineHeight: 18 },
	choices: { gap: 8 },
	choice: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 12,
		padding: 14,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	// The chosen card's edge, in white: the app's highlight colour (no accent hue).
	choiceOn: { borderColor: C.ink },
	choiceText: { flex: 1, gap: 3 },
	choiceTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	providerRow: { alignItems: "center" },
	providerHead: { flexDirection: "row", alignItems: "center", gap: 12 },
	stepBody: { color: C.ink, fontSize: 15, lineHeight: 21 },
	stepLink: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		height: 40,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.line,
	},
	stepLinkText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	stepBack: { color: C.muted, fontSize: 14, textAlign: "center" },
	link: { color: C.ink, fontSize: 13, fontWeight: "600", textDecorationLine: "underline" },
	savedRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		gap: 10,
	},
	price: { color: C.muted, fontSize: 13, lineHeight: 18, paddingHorizontal: 4 },
	primary: {
		marginTop: 8,
		height: 46,
		borderRadius: 12,
		backgroundColor: C.ink,
		alignItems: "center",
		justifyContent: "center",
	},
	primaryText: { color: C.bg, fontSize: 16, fontWeight: "700" },
	disabled: { opacity: 0.4 },
	note: { color: C.faint, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 },
	warn: { color: C.amber, fontSize: 13, lineHeight: 18 },
	errorBox: {
		padding: 12,
		borderRadius: 10,
		borderWidth: 1,
		borderColor: C.red,
		backgroundColor: "rgba(248,113,113,0.08)",
	},
	errorText: { color: C.red, fontSize: 13, lineHeight: 18 },
	step: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 22 },
	stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: C.line, marginHorizontal: 4 },
	stepText: { flex: 1, color: C.ink, fontSize: 14, lineHeight: 19 },
	stepWaiting: { color: C.faint },
	addressRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	addressInput: {
		flex: 1,
		height: 38,
		paddingHorizontal: 10,
		borderRadius: 8,
		borderWidth: 1,
		borderColor: C.line,
		color: C.ink,
		fontSize: 15,
	},
	smallBtn: {
		height: 38,
		paddingHorizontal: 14,
		borderRadius: 8,
		backgroundColor: C.sunken,
		alignItems: "center",
		justifyContent: "center",
	},
	smallBtnText: { color: C.ink, fontSize: 14, fontWeight: "600" },
	plain: { alignSelf: "center", paddingVertical: 8 },
	more: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		marginTop: 12,
		paddingHorizontal: 16,
		paddingVertical: 12,
		borderRadius: 12,
		borderWidth: 1,
		borderColor: C.line,
		backgroundColor: C.surface,
	},
	pressed: { opacity: 0.7 },
	moreText: { flex: 1, gap: 2 },
	stack: { flexDirection: "row", alignItems: "center" },
	stackCircle: {
		width: 28,
		height: 28,
		borderRadius: 14,
		borderWidth: 2,
		borderColor: C.surface,
		backgroundColor: C.sunken,
		alignItems: "center",
		justifyContent: "center",
	},
	stackOverlap: { marginLeft: -9 },
	moreTitle: { color: C.ink, fontSize: 15, fontWeight: "600" },
	moreBody: { color: C.muted, fontSize: 12, lineHeight: 17 },
	danger: { color: C.red, fontSize: 14, fontWeight: "600" },
});
