#!/usr/bin/env bash
# The last gate before `pnpm -r publish`: packs the three packages exactly as a publish would,
# checks every tarball (file allowlist, licence, manifest), installs them with npm in a scratch
# project outside the repository and uses them as a consumer would, then installs and type-checks
# the same consumer on the oldest supported and the newest viem 2.x. Ends with
# `pnpm -r publish --dry-run --no-git-checks`, whose file lists must equal the tarballs'.
#
# Usage: scripts/pack-check.sh
# Needs Node 24+, pnpm, npm and the npm registry (viem, typescript and @types/node are installed
# from it). No keys: `mantle-aa account status` runs for a throwaway key against
# MANTLE_SEPOLIA_RPC_URL (default: the public Mantle Sepolia RPC), read-only. PACK_CHECK_KEEP=1
# keeps the scratch directory. Exits non-zero on the first failed check.
# shellcheck disable=SC2016 # the single-quoted node -e programs are JavaScript, not shell
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RPC_URL=${MANTLE_SEPOLIA_RPC_URL:-https://rpc.sepolia.mantle.xyz}
PACKAGES=(sdk sponsor cli)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mantle-aa-pack-check.XXXXXX")
WORK=$(cd "$WORK" && pwd -P)
SERVE_PID=

cleanup() {
  if [[ -n $SERVE_PID ]]; then kill "$SERVE_PID" 2>/dev/null || true; fi
  if [[ ${PACK_CHECK_KEEP:-} == 1 ]]; then echo "scratch kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
step() { echo "== $*"; }

case "$WORK/" in "$(cd "$ROOT" && pwd -P)/"*) fail "the scratch directory $WORK is inside the repository" ;; esac

version_of() { node -p "require('$1/package.json').version"; }
VERSION=$(version_of "$ROOT/packages/sdk")
VIEM=$(version_of "$ROOT/node_modules/viem")
TYPESCRIPT=$(version_of "$ROOT/node_modules/typescript")
TYPES_NODE=$(version_of "$ROOT/node_modules/@types/node")
# The oldest viem the SDK's typecheck and tests pass with: 2.43.4 fixed the EIP-7702 UserOperation
# hash and initCode (`0x7702`) that the bundler path and the paymaster digest depend on; 2.43.3 and
# older fail them. The peer range must admit it, and a consumer on it must get one viem copy.
VIEM_MIN=2.43.4
VIEM_NEWEST=$(npm view 'viem@>=2 <3' version --json | node -e '
const v = [].concat(JSON.parse(require("fs").readFileSync(0, "utf8"))).filter((x) => /^2\.\d+\.\d+$/.test(x));
const n = (x) => x.split(".").map(Number);
v.sort((a, b) => n(a)[1] - n(b)[1] || n(a)[2] - n(b)[2]);
console.log(v.at(-1));
') || fail "npm view viem versions"
echo "version $VERSION; viem $VIEM (oldest supported $VIEM_MIN, newest 2.x $VIEM_NEWEST); node $(node --version); scratch $WORK"

step "pack (prepack runs a clean build)"
# A stale file in dist/ would be packed by `files: ["dist"]`: the clean build must remove it.
mkdir -p "$ROOT/packages/sdk/dist" && touch "$ROOT/packages/sdk/dist/pack-check-stale.js"
mkdir -p "$WORK/tgz"
for p in "${PACKAGES[@]}"; do
  (cd "$ROOT/packages/$p" && pnpm pack --pack-destination "$WORK/tgz" >"$WORK/pack-$p.log" 2>&1) ||
    { cat "$WORK/pack-$p.log" >&2; fail "pnpm pack of packages/$p"; }
  tgz="$WORK/tgz/0xwh1sker-mantle-aa-$p-$VERSION.tgz"
  [[ -f $tgz ]] || fail "no tarball $tgz"
  echo "$tgz"
done

step "tarball contents"
for p in "${PACKAGES[@]}"; do
  tgz="$WORK/tgz/0xwh1sker-mantle-aa-$p-$VERSION.tgz"
  mkdir -p "$WORK/x/$p" && tar xzf "$tgz" -C "$WORK/x/$p"
  tar tzf "$tgz" | sed 's|^package/||' | LC_ALL=C sort >"$WORK/files-$p.txt"
  bad=$(grep -v -E '^(package\.json|README\.md|LICENSE|dist/[A-Za-z0-9_/.-]+\.(js|d\.ts))$' "$WORK/files-$p.txt" || true)
  [[ -z $bad ]] || fail "$p: files outside the allowlist: $bad"
  required=(package.json README.md LICENSE dist/index.js dist/index.d.ts)
  [[ $p == sdk ]] && required+=(dist/mantle-sepolia.js)
  [[ $p == cli ]] && required+=(dist/bin.js)
  for f in "${required[@]}"; do grep -qxF "$f" "$WORK/files-$p.txt" || fail "$p: $f missing"; done
  ! grep -qxF dist/pack-check-stale.js "$WORK/files-$p.txt" || fail "$p: a stale dist/ file was packed"
  ! grep -rl sourceMappingURL "$WORK/x/$p/package/dist" || fail "$p: source map reference in dist"
  cmp -s "$ROOT/LICENSE" "$WORK/x/$p/package/LICENSE" || fail "$p: LICENSE differs from the repository's"
  echo "$p: $(wc -l <"$WORK/files-$p.txt" | tr -d ' ') files: $(grep -v '^dist/' "$WORK/files-$p.txt" | tr '\n' ' ')+ dist/*.js, dist/*.d.ts"
done
[[ $(head -1 "$WORK/x/cli/package/dist/bin.js") == '#!/usr/bin/env node' ]] || fail "cli: dist/bin.js has no node shebang"

step "packed manifests"
node - "$WORK/x" "$VERSION" "$VIEM" <<'EOF'
const { readFileSync } = require("node:fs");
const [dir, version, viem] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(`${dir}/${p}/package/package.json`, "utf8"));
const problems = [];
const expect = (ok, what) => ok || problems.push(what);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// ^2.a.b admits viem 2.c.d when (c, d) >= (a, b): the version the workspace builds and tests with.
const caretAdmits = (range, v) => {
  const r = /^\^2\.(\d+)\.(\d+)$/.exec(range ?? "");
  const [, c, d] = v.split(".").map(Number);
  return !!r && v.startsWith("2.") && (c > +r[1] || (c === +r[1] && d >= +r[2]));
};
const m = Object.fromEntries(["sdk", "sponsor", "cli"].map((p) => [p, read(p)]));
for (const [p, j] of Object.entries(m)) {
  const at = (what) => `${p}: ${what}`;
  expect(j.name === `@0xwh1sker/mantle-aa-${p}`, at(`name ${j.name}`));
  expect(j.version === version, at(`version ${j.version}, not ${version}`));
  expect(!("private" in j), at("private is set"));
  expect(j.license === "MIT", at(`license ${j.license}`));
  expect(j.type === "module", at("type is not module"));
  expect(typeof j.description === "string" && j.description.length > 0, at("no description"));
  expect(Array.isArray(j.keywords) && j.keywords.length > 0, at("no keywords"));
  expect(j.engines?.node === ">=24", at(`engines.node ${j.engines?.node}`));
  expect(j.publishConfig?.access === "public", at("publishConfig.access is not public"));
  expect(
    same(j.repository, {
      type: "git",
      url: "git+https://github.com/Whisker17/mantle-7702-sdk.git",
      directory: `packages/${p}`,
    }),
    at(`repository ${JSON.stringify(j.repository)}`),
  );
  expect(same(j.files, ["dist"]), at(`files ${JSON.stringify(j.files)}`));
  expect(
    same(j.exports, { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } }),
    at(`exports ${JSON.stringify(j.exports)}`),
  );
  expect(!/"(workspace|link|file|catalog):/.test(JSON.stringify(j)), at("a workspace:/link:/file:/catalog: spec is left"));
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) expect(!j.scripts?.[s], at(`runs a ${s} script on install`));
}
expect(same(m.sdk.dependencies ?? {}, {}), `sdk: dependencies ${JSON.stringify(m.sdk.dependencies)}`);
expect(caretAdmits(m.sdk.peerDependencies?.viem, viem), `sdk: peer viem ${m.sdk.peerDependencies?.viem} does not admit ${viem}`);
// One range for all three: a narrower sponsor/CLI range would nest a second viem for a consumer
// whose viem the SDK's peer range admits.
for (const p of ["sponsor", "cli"]) expect(m[p].dependencies?.viem === m.sdk.peerDependencies?.viem, `${p}: viem ${m[p].dependencies?.viem}, not the SDK's peer range ${m.sdk.peerDependencies?.viem}`);
expect(same(Object.keys(m.sdk.peerDependencies ?? {}), ["viem"]), "sdk: peer dependencies other than viem");
for (const p of ["sponsor", "cli"]) {
  expect(m[p].dependencies?.["@0xwh1sker/mantle-aa-sdk"] === version, `${p}: depends on sdk ${m[p].dependencies?.["@0xwh1sker/mantle-aa-sdk"]}`);
  expect(caretAdmits(m[p].dependencies?.viem, viem), `${p}: viem ${m[p].dependencies?.viem}`);
  expect(!m[p].peerDependencies, `${p}: has peer dependencies`);
}
expect(m.cli.dependencies?.["@0xwh1sker/mantle-aa-sponsor"] === version, "cli: sponsor dependency");
expect(same(m.cli.bin, { "mantle-aa": "./dist/bin.js" }) || same(m.cli.bin, { "mantle-aa": "dist/bin.js" }), `cli: bin ${JSON.stringify(m.cli.bin)}`);
for (const p of ["sdk", "sponsor"]) expect(!m[p].bin, `${p}: has a bin`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
for (const [p, j] of Object.entries(m)) console.log(`${j.name}@${j.version}`, JSON.stringify({ dependencies: j.dependencies, peerDependencies: j.peerDependencies }));
EOF

step "install the tarballs in a scratch project"
APP="$WORK/app"
mkdir -p "$APP" && cd "$APP"
npm init -y >/dev/null && npm pkg set type=module private=true >/dev/null
# The sponsor's and the CLI's dependency on the SDK (`$VERSION`) must be met by the local tarball:
# an npm that went to the registry for it would test something else (or 404 before the release).
npm install --no-audit --no-fund --loglevel=error \
  "$WORK/tgz/0xwh1sker-mantle-aa-sdk-$VERSION.tgz" \
  "$WORK/tgz/0xwh1sker-mantle-aa-sponsor-$VERSION.tgz" \
  "$WORK/tgz/0xwh1sker-mantle-aa-cli-$VERSION.tgz" \
  "viem@$VIEM" "typescript@$TYPESCRIPT" "@types/node@$TYPES_NODE"
npm ls --all >/dev/null || fail "npm ls reports a missing or invalid dependency"
node -e '
const lock = require("./package-lock.json").packages;
const ours = Object.keys(lock).filter((k) => k.includes("node_modules/@0xwh1sker/"));
const want = ["cli", "sdk", "sponsor"].map((p) => `node_modules/@0xwh1sker/mantle-aa-${p}`);
if (JSON.stringify(ours.sort()) !== JSON.stringify(want)) throw new Error(`installed: ${ours.join(", ")}`);
for (const k of want) if (!lock[k].resolved?.startsWith("file:")) throw new Error(`${k} resolved from ${lock[k].resolved}`);
' || fail "the packages are not installed once each, from the tarballs"
viems=$(npm ls viem --all --parseable | sort -u)
[[ $viems == "$APP/node_modules/viem" ]] || fail "expected one viem copy at node_modules/viem, found: $viems"
echo "one viem copy: node_modules/viem ($(version_of "$APP/node_modules/viem"))"

step "SDK: the in-package address book"
node --input-type=module -e '
import { loadDeployments, PACKAGE_NAME } from "@0xwh1sker/mantle-aa-sdk";
const book = loadDeployments();
if (book.chainId !== 5003) throw new Error(`loadDeployments().chainId = ${book.chainId}`);
console.log(`${PACKAGE_NAME}: loadDeployments().chainId = ${book.chainId}, CaliburEntry ${book.caliburEntry}`);
'

step "sponsor: node:sqlite, a config without deployments:, startSponsor and /health"
cat >"$WORK/sponsor.yaml" <<EOF
chainId: 5003
rpcUrl: \${PACK_CHECK_RPC_URL}
listen: { host: 127.0.0.1, port: 0 }
database: ./sponsor.sqlite
relayer: "0x000000000000000000000000000000000000dEaD"
policy:
  allowlist: []
  accountDailyGas: 5000000
  maxFeePerRequestMnt: "0.05"
  dailyBudgetMnt: "1"
  managementReserveMnt: "0.2"
EOF
PACK_CHECK_RPC_URL=$RPC_URL timeout 60 node --input-type=module -e '
import { isDeepStrictEqual } from "node:util";
import { loadDeployments } from "@0xwh1sker/mantle-aa-sdk";
import { loadConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
const config = loadConfig(process.argv[1]);
if (!isDeepStrictEqual(config.addresses, loadDeployments())) throw new Error("the default address book differs from the SDK book");
const sponsor = await startSponsor(config); // no keys: decides, never submits; opens the SQLite ledger
try {
  const health = await (await fetch(`${sponsor.url}/health`, { signal: AbortSignal.timeout(10_000) })).json();
  if (health.status !== "ok" || health.chainId !== 5003) throw new Error(`/health ${JSON.stringify(health)}`);
  console.log(`startSponsor: /health ${JSON.stringify(health)}`);
} finally {
  await sponsor.close();
}
' "$WORK/sponsor.yaml"

step "CLI: the mantle-aa bin"
npx --no-install mantle-aa --help >"$WORK/help.txt" || fail "npx mantle-aa --help exited $?"
grep -q '^usage: mantle-aa ' "$WORK/help.txt" || fail "mantle-aa --help printed no usage"
npx --no-install @0xwh1sker/mantle-aa-cli --help >/dev/null || fail "npx @0xwh1sker/mantle-aa-cli --help exited $?"
echo "npx mantle-aa --help and npx @0xwh1sker/mantle-aa-cli --help: exit 0"

step "CLI: sponsor serve with the default address book"
# The bin npm linked, run directly: $SERVE_PID is then the sponsor itself, not an npx wrapper.
PACK_CHECK_RPC_URL=$RPC_URL "$APP/node_modules/.bin/mantle-aa" sponsor serve --config "$WORK/sponsor.yaml" --json \
  >"$WORK/serve.out" 2>"$WORK/serve.err" &
SERVE_PID=$!
for _ in $(seq 60); do
  [[ -s $WORK/serve.out ]] && break
  kill -0 "$SERVE_PID" 2>/dev/null || break
  sleep 0.5
done
url=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8").split("\n")[0]); if (!r.ok) process.exit(1); console.log(r.result.url)' "$WORK/serve.out") ||
  { cat "$WORK/serve.out" "$WORK/serve.err" >&2; fail "sponsor serve did not report listening within 30 s"; }
health=$(curl -sf --max-time 10 "$url/health") || fail "sponsor serve: /health"
node -e 'const h = JSON.parse(process.argv[1]); if (h.status !== "ok" || h.chainId !== 5003) process.exit(1)' "$health" ||
  fail "sponsor serve: /health $health"
echo "sponsor serve: /health $health"
kill "$SERVE_PID"
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=

step "CLI: account status for a throwaway key (read-only, $( [[ -n ${MANTLE_SEPOLIA_RPC_URL:-} ]] && echo MANTLE_SEPOLIA_RPC_URL || echo the public RPC))"
export MANTLE_AA_HOME="$WORK/home" MANTLE_AA_RPC_URL=$RPC_URL
MANTLE_AA_KEYSTORE_PASSWORD=$(node -p 'require("crypto").randomBytes(16).toString("hex")')
export MANTLE_AA_KEYSTORE_PASSWORD
timeout 60 npx --no-install mantle-aa keys new --name pack-check --json >"$WORK/keys.json" ||
  fail "keys new exited $?: $(cat "$WORK/keys.json")"
timeout 180 npx --no-install mantle-aa account status --json >"$WORK/status.json" ||
  fail "account status exited $?: $(cat "$WORK/status.json")"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!r.ok || r.command !== "account status") process.exit(1);
const { sessions, ...rest } = r.result;
console.log(`account status: ok, ${JSON.stringify(rest).slice(0, 300)}`);
' "$WORK/status.json" || fail "account status: $(cat "$WORK/status.json")"
unset MANTLE_AA_HOME MANTLE_AA_RPC_URL MANTLE_AA_KEYSTORE_PASSWORD

step "TypeScript consumer: its own viem PublicClient into the SDK"
cat >consumer.ts <<'EOF'
import { run } from "@0xwh1sker/mantle-aa-cli";
import {
  type CaliburDomain,
  getChain,
  loadDeployments,
  MantleAccount,
  PrivateKeySigner,
  RelayerExecutor,
  readCaliburDomain,
} from "@0xwh1sker/mantle-aa-sdk";
import { loadConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import { createPublicClient, http, type PublicClient } from "viem";
import { generatePrivateKey } from "viem/accounts";

const addresses = loadDeployments();
const client: PublicClient = createPublicClient({ chain: getChain(addresses.chainId), transport: http() });
const executor = new RelayerExecutor({ client, url: "http://127.0.0.1:8548" });
export const account = new MantleAccount({
  client,
  root: new PrivateKeySigner(generatePrivateKey()),
  executor,
  keystore: { home: "/nonexistent" },
});
export const domain: Promise<CaliburDomain> = readCaliburDomain(client, addresses.caliburEntry);
// @ts-expect-error a string is not a viem Client: fails if the SDK's types resolved to `any`
readCaliburDomain("not a client", addresses.caliburEntry);
export const start: typeof startSponsor = startSponsor;
export const load: (path: string) => ReturnType<typeof loadConfig> = loadConfig;
export const cli: (argv: string[]) => Promise<number> = run;
EOF
cat >tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noEmit": true,
    "skipLibCheck": false,
    "types": ["node"]
  },
  "files": ["consumer.ts"]
}
EOF
npx --no-install tsc -p tsconfig.json || fail "the consumer does not type-check"
echo "tsc -p tsconfig.json (skipLibCheck false): exit 0"

# A consumer already on another viem 2.x: npm must accept it for the SDK's peer and the sponsor's and
# the CLI's dependency (no ERESOLVE, no nested copy), and the same consumer must type-check.
for v in "$VIEM_MIN" "$VIEM_NEWEST"; do
  step "consumer on viem $v: install, one viem copy, type-check"
  ALT="$WORK/app-viem-$v"
  mkdir -p "$ALT" && cd "$ALT"
  npm init -y >/dev/null && npm pkg set type=module private=true >/dev/null
  npm install --no-audit --no-fund --loglevel=error \
    "$WORK/tgz/0xwh1sker-mantle-aa-sdk-$VERSION.tgz" \
    "$WORK/tgz/0xwh1sker-mantle-aa-sponsor-$VERSION.tgz" \
    "$WORK/tgz/0xwh1sker-mantle-aa-cli-$VERSION.tgz" \
    "viem@$v" "typescript@$TYPESCRIPT" "@types/node@$TYPES_NODE" || fail "npm install with viem@$v"
  npm ls --all >/dev/null || fail "viem@$v: npm ls reports a missing or invalid dependency"
  viems=$(npm ls viem --all --parseable | sort -u)
  [[ $viems == "$ALT/node_modules/viem" ]] || fail "viem@$v: expected one viem copy at node_modules/viem, found: $viems"
  [[ $(version_of "$ALT/node_modules/viem") == "$v" ]] || fail "viem@$v: installed $(version_of "$ALT/node_modules/viem")"
  echo "one viem copy: node_modules/viem ($v)"
  cp "$APP/consumer.ts" "$APP/tsconfig.json" .
  npx --no-install tsc -p tsconfig.json || fail "viem@$v: the consumer does not type-check"
  echo "viem@$v: tsc -p tsconfig.json (skipLibCheck false): exit 0"
done

step "pnpm -r publish --dry-run --no-git-checks"
cd "$ROOT"
pnpm -r publish --dry-run --no-git-checks --report-summary 2>&1 | tee "$WORK/publish.log"
mv pnpm-publish-summary.json "$WORK/"
node - "$WORK" "$VERSION" <<'EOF'
const { readFileSync } = require("node:fs");
const [work, version] = process.argv.slice(2);
const { publishedPackages } = JSON.parse(readFileSync(`${work}/pnpm-publish-summary.json`, "utf8"));
const ids = publishedPackages.map((p) => p.id).sort();
const want = ["cli", "sdk", "sponsor"].map((p) => `@0xwh1sker/mantle-aa-${p}@${version}`);
if (JSON.stringify(ids) !== JSON.stringify(want)) throw new Error(`dry run would publish ${ids.join(", ")}`);
for (const pkg of publishedPackages) {
  const p = pkg.name.replace("@0xwh1sker/mantle-aa-", "");
  const files = pkg.files.map((f) => f.path).sort();
  const packed = readFileSync(`${work}/files-${p}.txt`, "utf8").trim().split("\n");
  if (JSON.stringify(files) !== JSON.stringify(packed)) throw new Error(`${pkg.id}: the dry run's files differ from the checked tarball's`);
  console.log(`${pkg.id}: ${files.length} files, the checked tarball's (${pkg.size} bytes packed)`);
}
EOF

echo "pack-check: all checks passed"
