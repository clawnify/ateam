#!/usr/bin/env node
// Distribute an already-uploaded TestFlight build to beta groups via the App Store
// Connect API. Run AFTER `xcrun altool --upload-app`: it waits for Apple to finish
// PROCESSING the build (a build can't be assigned to a group until then), then adds
// it to the named groups. Default groups: External + Ateam (internal).
//
// Adding to an EXTERNAL group triggers Apple's Beta App Review ("Waiting for Review")
// — this automates the manual "add build to group" click, NOT Apple's review wait.
// Export compliance is auto-answered by ITSAppUsesNonExemptEncryption:false in app.json.
//
//   Usage: ASC_ISSUER_ID=<uuid> node scripts/testflight-distribute.mjs <buildNumber> [group…]
//   Auth:  ~/.appstoreconnect/private_keys/AuthKey_<KID>.p8  (KID read from the filename)
//   Dry run: DRY_RUN=1 …  (resolves app + build, skips the assignment POST)

import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUNDLE_ID = "com.clawnify.ateam";
const buildNumber = process.argv[2];
// Only EXTERNAL groups need explicit assignment; internal groups auto-receive every
// processed build (the API rejects assigning a build to one). Default: External.
const groups = process.argv.slice(3).length ? process.argv.slice(3) : ["External"];
if (!buildNumber) {
	console.error("usage: testflight-distribute.mjs <buildNumber> [group…]");
	process.exit(2);
}
const ISS = process.env.ASC_ISSUER_ID;
if (!ISS) {
	console.error("set ASC_ISSUER_ID (the App Store Connect issuer UUID)");
	process.exit(2);
}

const keyDir = join(homedir(), ".appstoreconnect", "private_keys");
const keyFile = readdirSync(keyDir).find((f) => /^AuthKey_.+\.p8$/.test(f));
if (!keyFile) {
	console.error(`no AuthKey_*.p8 in ${keyDir}`);
	process.exit(2);
}
const KID = keyFile.replace(/^AuthKey_|\.p8$/g, "");
const key = readFileSync(join(keyDir, keyFile));

// A fresh ES256 JWT per call (short-lived; ASC caps token life at 20 min).
function token() {
	const now = Math.floor(Date.now() / 1000);
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const input = `${b64({ alg: "ES256", kid: KID, typ: "JWT" })}.${b64({ iss: ISS, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })}`;
	const sig = crypto
		.sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
		.toString("base64url");
	return `${input}.${sig}`;
}

async function api(path, opts = {}) {
	const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${token()}`,
			"Content-Type": "application/json",
			...(opts.headers || {}),
		},
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const app = await api(`/v1/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`);
const appId = app.body.data?.[0]?.id;
if (!appId) {
	console.error("app not found:", JSON.stringify(app.body.errors ?? app.body));
	process.exit(1);
}

// Wait for Apple to finish processing this build number (up to ~20 min).
let buildId;
let state;
for (let i = 0; i < 40; i++) {
	const b = await api(`/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&limit=1`);
	const build = b.body.data?.[0];
	buildId = build?.id;
	state = build?.attributes?.processingState;
	if (state === "VALID") break;
	console.log(`build ${buildNumber}: ${state ?? "not found yet"} — waiting…`);
	await new Promise((r) => setTimeout(r, 30_000));
}
if (!buildId) {
	console.error(`build ${buildNumber} not found for ${BUNDLE_ID}`);
	process.exit(1);
}
if (state !== "VALID") {
	console.error(`build ${buildNumber} still ${state} after wait — re-run later`);
	process.exit(1);
}
console.log(`build ${buildNumber} processed (id ${buildId})`);

const gs = await api(`/v1/betaGroups?limit=200`);
const byName = new Map(
	(gs.body.data ?? []).map((g) => [g.attributes.name, { id: g.id, internal: g.attributes.isInternalGroup }]),
);
for (const name of groups) {
	const g = byName.get(name);
	if (!g) {
		console.error(`group "${name}" not found — skipping`);
		continue;
	}
	if (g.internal) {
		console.log(`"${name}" is internal — builds auto-distribute, no assignment needed`);
		continue;
	}
	const gid = g.id;
	if (process.env.DRY_RUN) {
		console.log(`[dry-run] would add build ${buildNumber} to "${name}" (${gid})`);
		continue;
	}
	const r = await api(`/v1/betaGroups/${gid}/relationships/builds`, {
		method: "POST",
		body: JSON.stringify({ data: [{ type: "builds", id: buildId }] }),
	});
	// 204 = added. An already-present build returns a 409-ish error — report, don't fail.
	if (r.status === 204) console.log(`✓ added to "${name}"`);
	else console.log(`"${name}": ${r.status} — ${r.body.errors?.[0]?.detail ?? JSON.stringify(r.body)}`);
}
