// Lands one UserOp on Mantle Sepolia through a running strict bundler (e2e/bundler/sepolia.sh),
// sponsored by the deployed VerifyingPaymaster: the root init UserOp of a fresh EOA, carrying
// `eip7702Auth`, whose batch mints 1 mUSD (MockUSD) to the account. Prints the result and the
// bundle's fee split (what the executor paid vs. what the EntryPoint refunded it) as JSON.
//
// Run with Node (no build step): node e2e/bundler/land-sepolia.ts
// Env: MANTLE_SEPOLIA_RPC_URL, PAYMASTER_SIGNER_PRIVATE_KEY (the paymaster's verifyingSigner),
//      BUNDLER_URL (default http://127.0.0.1:4337). The fresh root key stays in memory: the
//      account holds no MNT and is only used once.
import { readFileSync } from "node:fs";
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  type Hex,
  http,
  parseAbi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendSponsoredUserOp } from "./userop.ts";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const signerKey = process.env.PAYMASTER_SIGNER_PRIVATE_KEY as Hex | undefined;
if (!rpcUrl || !signerKey) {
  throw new Error("MANTLE_SEPOLIA_RPC_URL and PAYMASTER_SIGNER_PRIVATE_KEY are required");
}
const bundlerUrl = process.env.BUNDLER_URL ?? "http://127.0.0.1:4337";
const book = JSON.parse(
  readFileSync(new URL("../../deployments/mantle-sepolia.json", import.meta.url), "utf8"),
) as Record<string, { address: Address }>;
const address = (name: string) => {
  const entry = book[name];
  if (!entry) throw new Error(`deployments/mantle-sepolia.json has no ${name}`);
  return entry.address;
};

const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) });
const chainId = await client.getChainId();
if (chainId !== 5003) throw new Error(`not Mantle Sepolia: chain id ${chainId}`);
const root = privateKeyToAccount(generatePrivateKey());
const result = await sendSponsoredUserOp({
  client,
  bundlerUrl,
  chainId,
  root,
  authorization: await root.signAuthorization({
    address: address("CaliburEntry"),
    chainId,
    nonce: 0,
  }),
  calls: [
    {
      to: address("MockUSD"),
      value: 0n,
      data: encodeFunctionData({
        abi: parseAbi(["function mint(address to, uint256 amount)"]),
        args: [root.address, 1_000_000n],
      }),
    },
  ],
  paymaster: address("VerifyingPaymaster"),
  paymasterSigner: privateKeyToAccount(signerKey),
  sendAttempts: 3,
  timeoutMs: 180_000,
});

// The bundle is mined (the bundler returned its receipt), so the receipt read cannot block.
const tx = await client.getTransaction({ hash: result.receipt.transactionHash });
const raw = (await client.request({
  method: "eth_getTransactionReceipt",
  params: [result.receipt.transactionHash],
})) as Record<string, Hex | undefined> | null;
if (!raw) throw new Error("bundle receipt not found");
const big = (field: string) => BigInt(raw[field] ?? "0x0");
// Mantle (Arsia): sender pays L2 gas + l1Fee + gasUsed × operatorFeeScalar × 100 + constant.
const l2Fee = big("gasUsed") * big("effectiveGasPrice");
const operatorFee = big("gasUsed") * big("operatorFeeScalar") * 100n + big("operatorFeeConstant");
const paid = l2Fee + big("l1Fee") + operatorFee;
const refund = BigInt(result.actualGasCost);
const balance = (blockNumber: bigint) => client.getBalance({ address: tx.from, blockNumber });
const blockNumber = BigInt(result.receipt.blockNumber);

console.log(
  JSON.stringify(
    {
      account: root.address,
      userOpHash: result.userOpHash,
      success: result.success,
      paymaster: result.paymaster,
      transactionHash: result.receipt.transactionHash,
      explorer: `https://sepolia.mantlescan.xyz/tx/${result.receipt.transactionHash}`,
      blockNumber: blockNumber.toString(),
      txType: tx.type,
      executor: tx.from,
      accountCode: await client.getCode({ address: root.address }),
      gas: {
        callGasLimit: result.sent.callGasLimit.toString(),
        verificationGasLimit: result.sent.verificationGasLimit.toString(),
        preVerificationGas: result.sent.preVerificationGas.toString(),
        paymasterVerificationGasLimit: result.sent.paymasterVerificationGasLimit?.toString(),
        maxFeePerGas: result.sent.maxFeePerGas.toString(),
        actualGasUsed: BigInt(result.actualGasUsed).toString(),
      },
      fees: {
        bundleGasUsed: big("gasUsed").toString(),
        effectiveGasPrice: big("effectiveGasPrice").toString(),
        l2Fee: l2Fee.toString(),
        l1Fee: big("l1Fee").toString(),
        operatorFee: operatorFee.toString(),
        executorPaid: paid.toString(),
        executorBalanceDelta: (
          (await balance(blockNumber)) - (await balance(blockNumber - 1n))
        ).toString(),
        entryPointRefund: refund.toString(),
        executorNet: (refund - paid).toString(),
      },
    },
    null,
    2,
  ),
);
