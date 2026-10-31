import type { GithubIssueDTO } from "@ateam/protocol";
import { CircleDot, ExternalLink, ImagePlus, Play, X } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "./IconButton";
import "./github-issues.css";

export function GithubIssueCard({
	issue,
	selected,
	onSelect,
}: {
	issue: GithubIssueDTO;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			className={`card issue-card ${selected ? "selected" : ""}`}
			onClick={(event) => {
				event.stopPropagation();
				onSelect();
			}}
		>
			<div className="issue-source">
				<CircleDot size={13} />
				<span>#{issue.number}</span>
			</div>
			<div className="name">{issue.title}</div>
			<div className="issue-labels">
				{issue.labels.map((label) => (
					<span className="pill" key={label}>
						{label}
					</span>
				))}
			</div>
			<div className="meta">GitHub issue</div>
		</button>
	);
}

export function GithubIssuePanel({
	issue,
	onClose,
	onStart,
}: {
	issue: GithubIssueDTO;
	onClose: () => void;
	onStart: () => void;
}) {
	return (
		<aside className="panel issue-panel" aria-label={`Issue #${issue.number} details`}>
			<div className="actions">
				<CircleDot size={14} />
				<span className="spacer">
					{new URL(issue.url).pathname.split("/").slice(1, 3).join("/")} · #{issue.number}
				</span>
				<IconButton icon={X} label="Close issue" onClick={onClose} />
			</div>
			<div className="issue-description">
				<div className="issue-source">
					<CircleDot size={14} />
					Open
				</div>
				<h2>{issue.title}</h2>
				<div className="issue-byline">Opened by {issue.author}</div>
				<div className="issue-labels">
					{issue.labels.map((label) => (
						<span className="pill" key={label}>
							{label}
						</span>
					))}
				</div>
				<a className="navbtn" href={issue.url} target="_blank" rel="noreferrer">
					Open in GitHub <ExternalLink size={12} />
				</a>
				<div className="issue-body">{issue.body || "No description provided."}</div>
			</div>
			<div className="issue-start">
				<p>Start a task with this issue’s title and description.</p>
				<button type="button" className="primary" onClick={onStart}>
					<Play size={13} /> Start task…
				</button>
			</div>
		</aside>
	);
}

/** What gh uploads (internal/attachments/userasset.go): images up to 10 MB. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MIME_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface IssueImage {
	/** The name the body refers to as `./<name>`, unique in this issue. */
	name: string;
	file: File;
	/** data: URL, read after adding (the renderer's CSP allows no blob: images). */
	preview?: string;
}

/** A name the engine accepts and gh can match: "Screenshot 2026-10-28 at 10.00.png"
 * becomes "Screenshot-2026-10-28-at-10-00.png", numbered when taken ("image-2.png"). */
function imageName(file: File, taken: Set<string>): string | null {
	const ext = IMAGE_EXT.exec(file.name)?.[1]?.toLowerCase() ?? MIME_EXT[file.type];
	if (!ext) return null;
	const base =
		file.name
			.replace(IMAGE_EXT, "")
			.replace(/[^\w-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "image";
	let name = `${base}.${ext}`;
	for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}.${ext}`;
	taken.add(name.toLowerCase());
	return name;
}

function readDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

export function NewIssueDialog({
	repository,
	onClose,
	onCreated,
}: {
	repository: string;
	onClose: () => void;
	onCreated: (issue: GithubIssueDTO) => void;
}) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [images, setImages] = useState<IssueImage[]>([]);
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const bodyRef = useRef<HTMLTextAreaElement>(null);
	const pickerRef = useRef<HTMLInputElement>(null);

	// Like github.com: each image lands as a reference at the caret, which gh
	// rewrites to the uploaded asset. One whose reference is deleted is appended.
	const addImages = (files: File[]) => {
		if (busy || files.length === 0) return;
		const taken = new Set(images.map((i) => i.name.toLowerCase()));
		const added: IssueImage[] = [];
		let rejected: string | null = null;
		for (const file of files) {
			const name = imageName(file, taken);
			if (!name) rejected = "Only PNG, JPEG, GIF, WebP and SVG images can be attached.";
			else if (file.size > MAX_IMAGE_BYTES) rejected = `${file.name} is over GitHub's 10 MB limit.`;
			else added.push({ name, file });
		}
		setError(rejected);
		if (added.length === 0) return;
		setImages((cur) => [...cur, ...added]);
		for (const image of added)
			void readDataUrl(image.file).then((preview) =>
				setImages((cur) => cur.map((i) => (i === image ? { ...i, preview } : i))),
			);
		const el = bodyRef.current;
		const at = el && document.activeElement === el ? el.selectionStart : body.length;
		const before = body.slice(0, at);
		const after = body.slice(el && document.activeElement === el ? el.selectionEnd : at);
		const refs = added.map((i) => `![${i.name.replace(/\.\w+$/, "")}](./${i.name})`).join("\n");
		const lead = before && !before.endsWith("\n") ? "\n" : "";
		const trail = after && !after.startsWith("\n") ? "\n" : "";
		setBody(`${before}${lead}${refs}${trail}${after}`);
	};
	const removeImage = (image: IssueImage) => {
		setImages((cur) => cur.filter((i) => i.name !== image.name));
		const ref = new RegExp(
			`!\\[[^\\]]*\\]\\(\\./${image.name.replace(/[.-]/g, "\\$&")}\\)\\n?`,
			"g",
		);
		setBody((cur) => cur.replace(ref, ""));
	};

	const submit = async () => {
		if (!title.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			const attached = await Promise.all(
				images.map(async (i) => ({
					name: i.name,
					base64: (i.preview ?? (await readDataUrl(i.file))).replace(/^data:[^,]*,/, ""),
				})),
			);
			onCreated(
				await window.ateam.projects.createIssue(repository, {
					title,
					body,
					...(attached.length ? { images: attached } : {}),
				}),
			);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			setError(
				/Unknown method/.test(message)
					? "Update Ateam to create GitHub issues."
					: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""),
			);
			setBusy(false);
		}
	};
	return (
		<div className="overlay" onMouseDown={() => !busy && onClose()}>
			<form
				className={`dialog composer new-issue ${dragging ? "dropping" : ""}`}
				aria-label={`New issue in ${repository}`}
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={(e) => {
					if (e.key === "Escape" && !busy) onClose();
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						void submit();
					}
				}}
				onDragOver={(e) => {
					e.preventDefault();
					if (!busy) setDragging(true);
				}}
				onDragLeave={() => setDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragging(false);
					addImages(Array.from(e.dataTransfer.files));
				}}
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<div className="new-issue-repo">
					<CircleDot size={13} /> New issue in {repository}
				</div>
				<input
					// biome-ignore lint/a11y/noAutofocus: modal input should focus
					autoFocus
					className="comp-name"
					placeholder="Title"
					aria-label="Issue title"
					value={title}
					disabled={busy}
					onChange={(e) => setTitle(e.target.value)}
				/>
				<textarea
					ref={bodyRef}
					className="comp-prompt"
					placeholder="Description (Markdown). Paste or drop images here."
					aria-label="Issue description"
					value={body}
					disabled={busy}
					onChange={(e) => setBody(e.target.value)}
					onPaste={(e) => {
						const files = Array.from(e.clipboardData.files);
						if (files.length === 0) return;
						e.preventDefault();
						addImages(files);
					}}
				/>
				{images.length > 0 && (
					<div className="comp-files">
						{images.map((image) => (
							<span key={image.name} className="file-chip" title={image.file.name}>
								{image.preview && <img className="fc-thumb" src={image.preview} alt="" />}
								<span className="fc-name">{image.name}</span>
								<button
									type="button"
									className="fc-x"
									aria-label={`Remove ${image.name}`}
									disabled={busy}
									onClick={() => removeImage(image)}
								>
									<X size={12} strokeWidth={2.25} />
								</button>
							</span>
						))}
					</div>
				)}
				{error && (
					<div className="new-issue-error" role="alert">
						{error}
					</div>
				)}
				<div className="drow">
					<button
						type="button"
						className="iconbtn new-issue-attach"
						title="Attach images"
						aria-label="Attach images"
						disabled={busy}
						onClick={() => pickerRef.current?.click()}
					>
						<ImagePlus size={16} strokeWidth={1.75} />
					</button>
					<input
						ref={pickerRef}
						type="file"
						accept=".png,.jpg,.jpeg,.gif,.webp,.svg"
						multiple
						hidden
						onChange={(e) => {
							addImages(Array.from(e.target.files ?? []));
							e.target.value = "";
						}}
					/>
					<button type="button" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" className="primary" disabled={!title.trim() || busy}>
						{busy ? (images.length ? "Uploading…" : "Creating…") : "Create issue"}
					</button>
				</div>
			</form>
		</div>
	);
}
