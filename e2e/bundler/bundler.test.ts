// Smoke test of the strict bundler harness: start an anvil fork of Mantle Sepolia and a safe-mode
// Alto on it, then land one UserOp sponsored by the deployed VerifyingPaymaster. The op is a
// fresh EOA's root init UserOp: it carries `eip7702Auth` (factory `0x7702`), so the bundle is a
// type-4 transaction that delegates the EOA to CaliburEntry, and the paymaster hash covers the
// 2-byte `0x7702` initCode the bundler packs. Paymaster data is signed directly with a test key
// that replaces the paymaster's signer on the fork (no sponsor service involved).
// Skipped when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { loadDeployments } from "@mantle-aa/sdk";
import { concat, encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BundlerStack, setPaymasterSigner, startBundlerStack } from "./harness.js";
import { sendSponsoredUserOp } from "./userop.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

describe.skipIf(!rpcUrl)("strict-mode Alto on a Mantle Sepolia fork", () => {
  let stack: BundlerStack;
  const paymasterSigner = privateKeyToAccount(generatePrivateKey());
  const root = privateKeyToAccount(generatePrivateKey());

  beforeAll(async () => {
    stack = await startBundlerStack(rpcUrl as string);
    await setPaymasterSigner(stack.client, book.verifyingPaymaster, paymasterSigner.address);
  }, 360_000);

  afterAll(async () => {
    await stack?.stop();
  }, 30_000);

  it("lands a sponsored root init UserOp with eip7702Auth as a type-4 bundle", async () => {
    const { client, bundler } = stack;
    const result = await sendSponsoredUserOp({
      client,
      bundlerUrl: bundler.url,
      chainId: book.chainId,
      root,
      authorization: await root.signAuthorization({
        address: book.caliburEntry,
        chainId: book.chainId,
        nonce: 0,
      }),
      calls: [
        {
          to: book.mockUsd,
          value: 0n,
          data: encodeFunctionData({ abi: mintAbi, args: [root.address, 1_000_000n] }),
        },
      ],
      paymaster: book.verifyingPaymaster,
      paymasterSigner,
      logs: () => bundler.logs().slice(-4_000),
    });

    // Accepted through safe-mode validation: Alto traced it with its ERC-7562 collector.
    expect(bundler.logs()).toContain("tracerResult");
    expect(result.success).toBe(true);
    expect(result.paymaster.toLowerCase()).toBe(book.verifyingPaymaster.toLowerCase());
    const tx = await client.getTransaction({ hash: result.receipt.transactionHash });
    expect(tx.type).toBe("eip7702");
    expect(tx.from.toLowerCase()).toBe(bundler.executor.toLowerCase());
    expect(await client.getCode({ address: root.address })).toBe(
      concat(["0xef0100", book.caliburEntry]).toLowerCase(),
    );
    expect(
      await client.readContract({
        address: book.mockUsd,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [root.address],
      }),
    ).toBe(1_000_000n);
  }, 240_000);
});
