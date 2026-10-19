// Smoke test of the strict bundler harness: start an anvil fork of Mantle Sepolia and a safe-mode
// Alto on it, then land one UserOp sponsored by the deployed VerifyingPaymaster. The op is a
// fresh EOA's root init UserOp: it carries `eip7702Auth` (factory `0x7702`), so the bundle is a
// type-4 transaction that delegates the EOA to CaliburEntry, and the paymaster hash covers the
// 2-byte `0x7702` initCode the bundler packs. Paymaster data is signed directly with a test key
// that replaces the paymaster's signer on the fork (no sponsor service involved). A second test
// checks that Alto validates and bundles a UserOp while an earlier bundle is still unmined.
// Skipped when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { setTimeout as sleep } from "node:timers/promises";
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
    const sent = Date.now();
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
      logs: () => bundler.timeline(sent),
    });

    // Accepted through safe-mode validation: Alto traced it with its ERC-7562 collector.
    await bundler.traced(root.address, sent);
    expect(result.success).toBe(true);
    expect(result.paymaster.toLowerCase()).toBe(book.verifyingPaymaster.toLowerCase());
    const tx = await client.getTransaction({ hash: result.receipt.transactionHash });
    expect(tx.type).toBe("eip7702");
    expect(bundler.executors).toContain(tx.from.toLowerCase());
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

  it("validates and bundles a UserOp while another op's bundle is still unmined", async () => {
    // Alto's safe validator takes a free executor wallet for every validation, and a bundle's
    // wallet stays taken until a later block shows the bundle included. With a single executor the
    // second send waited for the next block (measured: 30.5 s with mining stopped, docs/infra.md
    // §10.6); with several, its bundle joins the first in anvil's pool before any block is mined.
    const { client, bundler } = stack;
    const init = async () => {
      const owner = privateKeyToAccount(generatePrivateKey());
      return sendSponsoredUserOp({
        client,
        bundlerUrl: bundler.url,
        chainId: book.chainId,
        root: owner,
        authorization: await owner.signAuthorization({
          address: book.caliburEntry,
          chainId: book.chainId,
          nonce: 0,
        }),
        calls: [
          {
            to: book.mockUsd,
            value: 0n,
            data: encodeFunctionData({ abi: mintAbi, args: [owner.address, 1n] }),
          },
        ],
        paymaster: book.verifyingPaymaster,
        paymasterSigner,
        logs: () => bundler.timeline(stopped),
      });
    };
    const pooled = async (count: number) => {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const { pending } = await client.request({ method: "txpool_status" as never });
        if (BigInt(pending as string) === BigInt(count)) return;
        if (Date.now() > deadline) {
          throw new Error(
            `not ${count} bundles in anvil's pool after 60 s\n${bundler.timeline(stopped)}`,
          );
        }
        await sleep(200);
      }
    };
    await client.setAutomine(false);
    await client.setIntervalMining({ interval: 0 });
    const stopped = Date.now();
    const first = init();
    const second = (async () => {
      await pooled(1);
      return init();
    })();
    try {
      await pooled(2);
    } finally {
      await client.setIntervalMining({ interval: 1 });
    }
    for (const result of await Promise.all([first, second])) expect(result.success).toBe(true);
  }, 240_000);
});
