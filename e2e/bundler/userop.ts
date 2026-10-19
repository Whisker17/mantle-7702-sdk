// Builds, sponsors and sends one EntryPoint v0.8 UserOp to a Calibur account through a bundler,
// signing the VerifyingPaymaster data directly with the paymaster signer's key (no sponsor
// service). Used by the fork smoke test and by the Mantle Sepolia landing script; imports only
// viem so Node can run it without a build step.
import {
  type Address,
  concat,
  encodeAbiParameters,
  type Hex,
  type LocalAccount,
  type PublicClient,
  parseAbi,
  type SignedAuthorization,
  toFunctionSelector,
} from "viem";
import {
  formatUserOperationRequest,
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";

export const ENTRY_POINT_V08: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";

const paymasterAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getHash(PackedUserOperation userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
]);
const entryPointAbi = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
]);

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

/** Calibur's 4337 calldata: `executeUserOp.selector ‖ abi.encode(BatchedCall(calls, true))`. */
export function executeUserOpData(calls: Call[]): Hex {
  const selector = toFunctionSelector(
    "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)",
  );
  const batched = encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            name: "calls",
            type: "tuple[]",
            components: [
              { name: "to", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
          { name: "revertOnFailure", type: "bool" },
        ],
      },
    ],
    [{ calls, revertOnFailure: true }],
  );
  return concat([selector, batched]);
}

/** One bundler JSON-RPC call (60 s bound). A JSON-RPC error throws, with `context()` appended. */
export async function bundlerRpc(
  url: string,
  method: string,
  params: unknown[],
  context: () => string = () => "",
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}\n${context()}`);
  return body.result;
}

export interface SponsoredUserOp {
  /** Chain reads: nonce, block time, `VerifyingPaymaster.getHash`. */
  client: Pick<PublicClient, "getBlock" | "readContract">;
  bundlerUrl: string;
  chainId: number;
  /** The account's root key (Calibur root signature: raw ECDSA over the userOpHash). */
  root: LocalAccount;
  calls: Call[];
  /** Set for the root's init UserOp only: the op then carries `eip7702Auth` (factory 0x7702). */
  authorization?: SignedAuthorization;
  paymaster: Address;
  paymasterSigner: LocalAccount;
  /** Percent applied to the bundler's verificationGasLimit estimate (anvil tracer headroom). */
  verificationGasPct?: bigint;
  /** Alto's recent log, appended to bundler errors. */
  logs?: () => string;
  /** Attempts at `eth_sendUserOperation` when Alto's validation trace times out (default 1). */
  sendAttempts?: number;
  /** Bound on waiting for the bundle receipt (ms). */
  timeoutMs?: number;
}

export interface UserOpReceipt {
  userOpHash: Hex;
  success: boolean;
  paymaster: Address;
  actualGasCost: Hex;
  actualGasUsed: Hex;
  receipt: { transactionHash: Hex; blockNumber: Hex };
  /** The op as sent (gas fields included). */
  sent: UserOperation<"0.8">;
}

/**
 * Builds the op, sizes it with `eth_estimateUserOperationGas`, signs the paymaster data
 * (`abi.encode(validUntil, validAfter) ‖ signature` over `getHash`, which covers the 2-byte
 * `0x7702` initCode the bundler packs) and the root signature, sends it and waits for its receipt.
 */
export async function sendSponsoredUserOp(p: SponsoredUserOp): Promise<UserOpReceipt> {
  const logs = p.logs ?? (() => "");
  const rpc = (method: string, params: unknown[]) => bundlerRpc(p.bundlerUrl, method, params, logs);
  const fees = (await rpc("pimlico_getUserOperationGasPrice", [])) as {
    standard: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex };
  };
  const validUntil = Number((await p.client.getBlock()).timestamp) + 600;
  const nonce = await p.client.readContract({
    address: ENTRY_POINT_V08,
    abi: entryPointAbi,
    functionName: "getNonce",
    args: [p.root.address, 0n],
  });

  const sign = async (o: UserOperation<"0.8">): Promise<UserOperation<"0.8">> => {
    const pmHash = await p.client.readContract({
      address: p.paymaster,
      abi: paymasterAbi,
      functionName: "getHash",
      args: [toPackedUserOperation({ ...o, paymasterData: "0x" }), validUntil, 0],
    });
    const paymasterData = concat([
      encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, 0]),
      await p.paymasterSigner.signMessage({ message: { raw: pmHash } }),
    ]);
    const signed = { ...o, paymasterData };
    const hash = getUserOperationHash({
      chainId: p.chainId,
      entryPointAddress: ENTRY_POINT_V08,
      entryPointVersion: "0.8",
      userOperation: signed,
    });
    if (!p.root.sign) throw new Error("root account cannot sign raw hashes");
    return { ...signed, signature: await p.root.sign({ hash }) };
  };

  let op: UserOperation<"0.8"> = await sign({
    sender: p.root.address,
    nonce,
    ...(p.authorization
      ? { factory: "0x7702", factoryData: "0x", authorization: p.authorization }
      : {}),
    callData: executeUserOpData(p.calls),
    callGasLimit: 300_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: BigInt(fees.standard.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(fees.standard.maxPriorityFeePerGas),
    paymaster: p.paymaster,
    paymasterVerificationGasLimit: 100_000n,
    paymasterPostOpGasLimit: 0n,
    paymasterData: "0x",
    signature: "0x",
  });
  const estimate = (await rpc("eth_estimateUserOperationGas", [
    formatUserOperationRequest(op),
    ENTRY_POINT_V08,
  ])) as Record<string, Hex | undefined>;
  const gas = (field: string) => BigInt(estimate[field] ?? "0x0");
  op = await sign({
    ...op,
    callGasLimit: gas("callGasLimit"),
    // Anvil's JS tracer over-reports the step after a returning call, which trips OP-020 on a
    // tight verificationGasLimit (docs/infra.md §3.5). Unused verification gas is not charged.
    verificationGasLimit: (gas("verificationGasLimit") * (p.verificationGasPct ?? 150n)) / 100n,
    preVerificationGas: gas("preVerificationGas"),
    paymasterVerificationGasLimit: gas("paymasterVerificationGasLimit"),
    paymasterPostOpGasLimit: gas("paymasterPostOpGasLimit"),
  });

  // A send whose validation trace timed out inside Alto is retried (same op): the first trace on
  // a fresh trace fork can exceed Alto's 10 s RPC timeout while the fork fetches state.
  let userOpHash: Hex | undefined;
  for (let attempt = 1; !userOpHash; attempt++) {
    try {
      userOpHash = (await rpc("eth_sendUserOperation", [
        formatUserOperationRequest(op),
        ENTRY_POINT_V08,
      ])) as Hex;
    } catch (e) {
      if (attempt >= (p.sendAttempts ?? 1) || !String(e).includes("took too long")) throw e;
    }
  }
  const timeoutMs = p.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = (await rpc("eth_getUserOperationReceipt", [userOpHash])) as Omit<
      UserOpReceipt,
      "userOpHash" | "sent"
    > | null;
    if (receipt) return { ...receipt, userOpHash, sent: op };
    if (Date.now() > deadline) {
      throw new Error(`no receipt for UserOp ${userOpHash} within ${timeoutMs} ms\n${logs()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
