#!/usr/bin/env bash
# Start / stop the strict bundler stack against the real Mantle Sepolia chain:
#   anvil fork (tracing node) <- trace-proxy.mjs (debug_* only) <- Alto (safe mode, EP v0.8)
#                                trace-proxy.mjs (everything else) -> upstream Mantle Sepolia RPC
# The public RPC rejects debug_*, hence the proxy; on a fork the harness (harness.ts) needs none.
# UPSTREAM_RPC_URL may carry an API key: no log in the run directory shows a URL (anvil's output
# goes through redact_urls, trace-proxy.mjs redacts its own).
#
# Alto is installed with `npm ci` from alto/package-lock.json into the run directory (outside the
# workspace). Unless ALTO_PATCH=0, alto/safe-validator.patch is applied: stock Alto cannot decode
# the safe-mode validation result for EntryPoint v0.7+ (see docs/infra.md); the patch fixes only
# that decoding.
#
# Usage: e2e/bundler/sepolia.sh up|down|status
# Env (up): BUNDLER_PRIVATE_KEY  executor + utility key for Alto (passed to Alto through its
#                                ALTO_* environment variables, never on a command line)
#           UPSTREAM_RPC_URL     default https://rpc.sepolia.mantle.xyz
#           BUNDLER_RUN_DIR      pid, log and install files, default $HOME/.mantle-aa/bundler-run
#           ALTO_PORT            default 4337
#           ALTO_PATCH           1 (default) patched, 0 stock
set -euo pipefail

ENTRY_POINT_V08=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
UPSTREAM_RPC_URL=${UPSTREAM_RPC_URL:-https://rpc.sepolia.mantle.xyz}
RUN_DIR=${BUNDLER_RUN_DIR:-$HOME/.mantle-aa/bundler-run}
ALTO_PORT=${ALTO_PORT:-4337}
ALTO_PATCH=${ALTO_PATCH:-1}
ANVIL_PORT=18545
PROXY_PORT=18546
HERE=$(cd "$(dirname "$0")" && pwd)

# Every URL becomes <redacted-url>, as redactUrls in packages/sdk/src/errors.ts.
redact_urls() {
	sed -E "s#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]\"'<>\`]+#<redacted-url>#g"
}

# Stop a process and its children.
kill_tree() {
	local child
	for child in $(pgrep -P "$1" || true); do kill_tree "$child"; done
	kill "$1" 2>/dev/null || true
}

stop() {
	for name in alto proxy anvil; do
		local pidfile="$RUN_DIR/$name.pid"
		if [[ -f $pidfile ]]; then
			local pid
			pid=$(cat "$pidfile")
			kill_tree "$pid"
			# Alto shuts down gracefully on SIGTERM; wait so its executor key is free afterwards.
			for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
			rm -f "$pidfile"
			echo "stopped $name"
		fi
	done
}

wait_rpc() {
	for _ in $(seq 1 60); do
		curl -sf -m 5 -X POST -H 'content-type: application/json' \
			--data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$1" >/dev/null && return 0
		sleep 1
	done
	echo "no answer from $1" >&2
	return 1
}

# Prints the alto binary of the pinned (and, unless ALTO_PATCH=0, patched) install.
install_alto() {
	local key dir
	key=$(cat "$HERE/alto/package-lock.json" "$HERE/alto/safe-validator.patch" | shasum -a 256 | cut -c1-12)
	dir="$RUN_DIR/alto-$key-patch$ALTO_PATCH"
	if [[ ! -x $dir/node_modules/.bin/alto ]]; then
		mkdir -p "$dir"
		cp "$HERE/alto/package.json" "$HERE/alto/package-lock.json" "$dir/"
		(cd "$dir" && npm ci --silent --no-fund --no-audit --ignore-scripts) >&2
		if [[ $ALTO_PATCH == 1 ]]; then
			patch -s -p1 -d "$dir/node_modules/@pimlico/alto" <"$HERE/alto/safe-validator.patch" >&2
		fi
	fi
	echo "$dir/node_modules/.bin/alto"
}

start() {
	: "${BUNDLER_PRIVATE_KEY:?BUNDLER_PRIVATE_KEY is required}"
	mkdir -p "$RUN_DIR"
	chmod 700 "$RUN_DIR"
	local alto
	alto=$(install_alto)

	# Tracing node: prague rules (no EIP-7825 per-tx gas cap); the proxy re-forks it to the head.
	nohup anvil --fork-url "$UPSTREAM_RPC_URL" --port "$ANVIL_PORT" --hardfork prague --silent \
		> >(redact_urls >"$RUN_DIR/anvil.log") 2>&1 &
	echo $! >"$RUN_DIR/anvil.pid"
	wait_rpc "http://127.0.0.1:$ANVIL_PORT"

	UPSTREAM_RPC_URL=$UPSTREAM_RPC_URL TRACE_RPC_URL="http://127.0.0.1:$ANVIL_PORT" PORT=$PROXY_PORT \
		nohup node "$HERE/trace-proxy.mjs" >"$RUN_DIR/proxy.log" 2>&1 &
	echo $! >"$RUN_DIR/proxy.pid"
	wait_rpc "http://127.0.0.1:$PROXY_PORT"

	ALTO_EXECUTOR_PRIVATE_KEYS=$BUNDLER_PRIVATE_KEY ALTO_UTILITY_PRIVATE_KEY=$BUNDLER_PRIVATE_KEY \
		nohup "$alto" \
		--entrypoints "$ENTRY_POINT_V08" \
		--rpc-url "http://127.0.0.1:$PROXY_PORT" \
		--safe-mode true \
		--chain-type mantle \
		--block-time 2000 \
		--port "$ALTO_PORT" \
		--refilling-wallets false \
		--deploy-simulations-contract true \
		--log-level info \
		--public-client-log-level warn \
		>"$RUN_DIR/alto.log" 2>&1 &
	echo $! >"$RUN_DIR/alto.pid"
	wait_rpc "http://127.0.0.1:$ALTO_PORT"
	echo "alto (safe mode, patch=$ALTO_PATCH) on http://127.0.0.1:$ALTO_PORT; logs in $RUN_DIR"
}

case ${1:-} in
up) start ;;
down) stop ;;
status)
	for name in anvil proxy alto; do
		pidfile="$RUN_DIR/$name.pid"
		if [[ -f $pidfile ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then echo "$name running"; else echo "$name stopped"; fi
	done
	;;
*)
	echo "usage: $0 up|down|status" >&2
	exit 2
	;;
esac
