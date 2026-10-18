#!/usr/bin/env bash
# Bundler path of the Mantle Sepolia feasibility spike (throwaway): build and sign a UserOp
# (EntryPoint v0.8) with SpikeUserOp.s.sol, size it with the bundler's estimate, send it, and wait
# for the bundle receipt.
#
# Usage: e2e/spike/userop.sh session <tag> [no-auth|with-auth]   session UserOp (default no-auth)
#        e2e/spike/userop.sh root-init                            root init UserOp + eip7702Auth
# Env: MANTLE_SEPOLIA_RPC_URL, BUNDLER_URL (default http://127.0.0.1:4337, e2e/bundler/sepolia.sh), VERIFICATION_GAS_PCT
#      (default 150, applied to the estimated verificationGasLimit), and the signer and
#      address variables SpikeUserOp.s.sol reads (*_PRIVATE_KEY, SPIKE_*).
set -euo pipefail

case ${1:-} in
session)
	TAG=${2:?usage: $0 session <tag> [no-auth|with-auth]}
	case ${3:-no-auth} in no-auth) AUTH=false ;; with-auth) AUTH=true ;; *) echo "bad mode" >&2; exit 2 ;; esac
	SIG=("session(uint256,bool)" "$TAG" "$AUTH")
	;;
root-init) SIG=("rootInit()") ;;
*)
	echo "usage: $0 session <tag> [no-auth|with-auth] | root-init" >&2
	exit 2
	;;
esac
BUNDLER_URL=${BUNDLER_URL:-http://127.0.0.1:4337}
EP=0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
: "${MANTLE_SEPOLIA_RPC_URL:?MANTLE_SEPOLIA_RPC_URL is required}"
CONTRACTS=$(cd "$(dirname "$0")/../../contracts" && pwd)

rpc() {
	curl -s -X POST -H 'content-type: application/json' \
		--data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$BUNDLER_URL"
}

# Prints the signed UserOp JSON for the current OP_* gas values. Retries: the public RPC's
# backends occasionally lag the head the fork was pinned to ("requested block is above the latest
# consensus block").
build() {
	local out
	for _ in 1 2 3; do
		out=$(cd "$CONTRACTS" && forge script script/spike/SpikeUserOp.s.sol --sig "${SIG[@]}" \
			--rpc-url "$MANTLE_SEPOLIA_RPC_URL" 2>&1 | sed -n 's/^ *SPIKE_USEROP=//p')
		[[ -n $out ]] && { echo "$out"; return; }
		sleep 2
	done
	echo "SpikeUserOp.s.sol failed three times" >&2
	return 1
}

fail_on_error() {
	if jq -e '.error' >/dev/null <<<"$1"; then
		echo "$2 failed: $(jq -c '.error' <<<"$1")" >&2
		exit 1
	fi
}

fees=$(rpc pimlico_getUserOperationGasPrice '[]')
fail_on_error "$fees" pimlico_getUserOperationGasPrice
OP_MAX_FEE=$(jq -r '.result.standard.maxFeePerGas' <<<"$fees")
OP_MAX_PRIORITY_FEE=$(jq -r '.result.standard.maxPriorityFeePerGas' <<<"$fees")
export OP_MAX_FEE OP_MAX_PRIORITY_FEE

draft=$(build)
estimate=$(rpc eth_estimateUserOperationGas "[$draft,\"$EP\"]")
fail_on_error "$estimate" eth_estimateUserOperationGas
echo "estimate: $(jq -c '.result' <<<"$estimate")"
OP_CALL_GAS=$(jq -r '.result.callGasLimit' <<<"$estimate")
# Headroom over the estimate: anvil's JS tracer reports the step after a returning call with the
# callee's gas as its cost, so a tight limit trips the bundler's OP-020 "internally reverts on
# oog" check on the tracing node (see docs/infra.md). Unused verification gas is not charged.
OP_VERIFICATION_GAS=$(($(jq -r '.result.verificationGasLimit' <<<"$estimate") * ${VERIFICATION_GAS_PCT:-150} / 100))
OP_PRE_VERIFICATION_GAS=$(jq -r '.result.preVerificationGas' <<<"$estimate")
OP_PM_VERIFICATION_GAS=$(jq -r '.result.paymasterVerificationGasLimit // "0x0"' <<<"$estimate")
OP_PM_POSTOP_GAS=$(jq -r '.result.paymasterPostOpGasLimit // "0x0"' <<<"$estimate")
export OP_CALL_GAS OP_VERIFICATION_GAS OP_PRE_VERIFICATION_GAS OP_PM_VERIFICATION_GAS OP_PM_POSTOP_GAS

op=$(build)
sent=$(rpc eth_sendUserOperation "[$op,\"$EP\"]")
fail_on_error "$sent" eth_sendUserOperation
hash=$(jq -r '.result' <<<"$sent")
echo "userOpHash: $hash"

for _ in $(seq 1 90); do
	receipt=$(rpc eth_getUserOperationReceipt "[\"$hash\"]")
	if [[ $(jq -r '.result' <<<"$receipt") != null ]]; then
		jq -c '.result | {success, actualGasCost, actualGasUsed, transactionHash: .receipt.transactionHash, blockNumber: .receipt.blockNumber}' <<<"$receipt"
		[[ $(jq -r '.result.success' <<<"$receipt") == true ]] || exit 1
		exit 0
	fi
	sleep 2
done
echo "no receipt for $hash after 180 s" >&2
exit 1
