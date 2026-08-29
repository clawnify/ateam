/**
 * Stage one of the search: a lexical rank over the digests. Pure and cheap, so
 * it runs on every keystroke and costs nothing.
 *
 * It is also what makes the AI stage affordable. Handing a whole history to a
 * model is slow, expensive and — measured against this repo's own transcripts —
 * LESS accurate than ranking first: with 200+ session summaries in one prompt
 * the model skims, while with 20 candidates it reads. This narrows; the re-rank
 * reads.
 *
 * Scoring is tf-idf with two adjustments that matter for sessions: a match in a
 * branch name or task title counts double (those are what the user named the
 * work), and recency breaks ties (yesterday's session is likelier the one being
 * remembered than one from March).
 */
import type { RankedSession, SessionDigest } from "./types";

/** A digest plus the task-side words worth searching alongside it. */
export interface RankInput {
	digest: SessionDigest;
	/** Task name, branch — the labels the user gave this work. */
	titles: string[];
}

/** Words too common to discriminate between sessions. */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"if",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"was",
	"were",
	"is",
	"are",
	"be",
	"been",
	"it",
	"its",
	"that",
	"this",
	"i",
	"we",
	"my",
	"our",
	"me",
	"us",
	"do",
	"did",
	"does",
	"how",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"session",
	"sessions",
	"working",
	"work",
	"worked",
	"about",
	"some",
	"any",
	"can",
	"could",
]);

export function terms(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/**
 * Weighted occurrences of `term` in `text`, counted at word starts only, so
 * "flick" finds "flickering" while "lick" does not.
 *
 * A prefix match counts for less than a whole word. Without that split,
 * searching for "box" ranked every session about "boxd" above the ones about
 * boxes — the prefix is worth keeping (it is free stemming for plurals and
 * "-ing" forms) but it is weaker evidence than the word the user actually typed.
 */
const PREFIX_WEIGHT = 0.4;

function count(text: string, term: string): number {
	let n = 0;
	let from = 0;
	for (;;) {
		const at = text.indexOf(term, from);
		if (at === -1) return n;
		const before = at === 0 ? " " : text.charAt(at - 1);
		if (!/[\p{L}\p{N}]/u.test(before)) {
			const after = text.charAt(at + term.length);
			n += after === "" || !/[\p{L}\p{N}]/u.test(after) ? 1 : PREFIX_WEIGHT;
		}
		from = at + term.length;
	}
}

/**
 * BM25 term saturation and length normalization, at the standard defaults.
 * Length normalization is not a nicety here: a session that pasted a long skill
 * body or an expanded slash command otherwise outranks the session that
 * actually discussed the thing, purely by containing more words. Plain tf-idf
 * put three such sessions in the top five on this repo's own history.
 */
const K1 = 1.2;
const B = 0.75;
const TITLE_WEIGHT = 2;
/** Ceiling on the recency tiebreaker, in score points. Small on purpose: it
 *  orders equals, it never outranks a better textual match. */
const RECENCY_BONUS = 0.5;
/** How long ago a session stops earning any recency bonus. */
const RECENCY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

interface Doc {
	input: RankInput;
	body: string;
	title: string;
	/** Approximate word count, for BM25's length normalization. */
	length: number;
}

/**
 * Terms the user did not type, contributed by query expansion. They widen
 * recall over a vocabulary gap, so they count — but for less than the words
 * the user chose, which stay the strongest evidence of what they meant.
 */
const EXPANSION_WEIGHT = 0.5;

export function rank(
	inputs: RankInput[],
	query: string,
	limit: number,
	opts: { expansions?: string[]; now?: number } = {},
): RankedSession[] {
	const now = opts.now ?? Date.now();
	const typed = terms(query);
	const extra = (opts.expansions ?? []).flatMap(terms).filter((t) => !typed.includes(t));
	const weightOf = (t: string) => (typed.includes(t) ? 1 : EXPANSION_WEIGHT);
	const qs = [...new Set([...typed, ...extra])];
	if (qs.length === 0 || inputs.length === 0) return [];

	const docs: Doc[] = inputs.map((input) => {
		const body = input.digest.prompts.join("\n").toLowerCase();
		return {
			input,
			body,
			title: input.titles.join(" ").toLowerCase(),
			// Word count is close enough to a length for normalization, and far
			// cheaper than tokenizing every session on every keystroke.
			length: body.length / 6 + 1,
		};
	});
	const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;

	// Document frequency across the corpus — a term every session contains
	// (this repo's name, say) must not decide the ranking.
	const idf = new Map<string, number>();
	for (const t of qs) {
		const df = docs.filter((d) => count(d.body, t) > 0 || count(d.title, t) > 0).length;
		idf.set(t, Math.log((docs.length + 1) / (df + 1)) + 1);
	}

	const scored: RankedSession[] = [];
	for (const doc of docs) {
		let score = 0;
		const hit: string[] = [];
		const norm = K1 * (1 - B + (B * doc.length) / avgLength);
		for (const t of qs) {
			const inBody = count(doc.body, t);
			const inTitle = count(doc.title, t);
			if (inBody === 0 && inTitle === 0) continue;
			hit.push(t);
			const tf = inBody + TITLE_WEIGHT * inTitle;
			score += weightOf(t) * (idf.get(t) ?? 1) * ((tf * (K1 + 1)) / (tf + norm));
		}
		if (score === 0) continue;
		// Breadth of match beats depth: a session touching every term the user
		// typed beats one that repeats a single term. Measured against the typed
		// terms only, so expansions can never make a session look more relevant
		// than one that used the user's own words.
		const typedHits = hit.filter((t) => typed.includes(t)).length;
		score *= 1 + Math.max(0, typedHits - 1) / Math.max(1, typed.length);
		const end = doc.input.digest.endedAt ?? 0;
		const age = now - end;
		if (end > 0 && age > 0 && age < RECENCY_WINDOW_MS) {
			score += RECENCY_BONUS * (1 - age / RECENCY_WINDOW_MS);
		}
		scored.push({
			digest: doc.input.digest,
			score,
			excerpts: excerptsFor(doc.input.digest, hit),
		});
	}
	scored.sort((a, b) => b.score - a.score || (b.digest.endedAt ?? 0) - (a.digest.endedAt ?? 0));
	return scored.slice(0, limit);
}

/** The prompt lines a match actually landed in — the excerpt shown in the UI
 *  and the context the re-rank reads. Falls back to the opening prompt, which
 *  is what a session is "about" when the match came from its title. */
export function excerptsFor(digest: SessionDigest, hits: string[], max = 4): string[] {
	const out: string[] = [];
	for (const p of digest.prompts) {
		const low = p.toLowerCase();
		if (hits.some((t) => count(low, t) > 0)) out.push(p);
		if (out.length >= max) break;
	}
	const first = digest.prompts[0];
	if (out.length === 0 && first) out.push(first);
	return out;
}
