import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AgentSession,
  type Call,
  caliburAbi,
  delegationDesignator,
  ERC20ETH,
  erc20Abi,
  getProfile,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  RelayerExecutor,
  RuleKind,
  SELECTORS,
  SponsorBusyError,
  SponsorRejectCode,
  SponsorRejectedError,
} from "@mantle-aa/sdk";
import { encodeFunctionData, parseEther, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clientFor, mockUsdAbi, RELAYER, startFork } from "../../sdk/test/account/fork.js";
import type { SponsorConfig } from "../src/config.js";
import { Ledger } from "../src/ledger.js";
import { createSponsorServer } from "../src/server.js";
import { SponsorStore } from "../src/store.js";
import { book, RELAYER_ADDRESS, testConfig } from "./fixtures.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;

const policy: Policy = {
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: 10n ** 9n, periodCap: 10n ** 9n }],
  periodLength: 86400,
  permissions: [{ target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE }],
  trustedSpenders: [PAD],
  maxDeadlineWindow: 600,
};
const approve = (amount: bigint): Call => ({
  to: USD,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PAD, amount] }),
});

// The real sponsor (HTTP server, ledger, relayer) in process, and the SDK reaching it only through
// RelayerExecutor. This test lives with the sponsor because the sponsor depends on the SDK.
describe.skipIf(!rpcUrl)("RelayerExecutor against the sponsor on a Mantle Sepolia fork", () => {
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;
  let store: SponsorStore;
  let ledger: Ledger;
  let server: ReturnType<typeof createSponsorServer>;
  let base: string;
  let executor: RelayerExecutor;
  let account: MantleAccount;
  const database = join(mkdtempSync(join(tmpdir(), "relayer-executor-fork-")), "sponsor.sqlite");
  const keystore = {
    home: mkdtempSync(join(tmpdir(), "relayer-executor-fork-")),
    password: "test",
    scrypt: { n: 1024, r: 8, p: 1 },
  };
  const root = new PrivateKeySigner(generatePrivateKey());
  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method, params } as never) as Promise<unknown>;
  const allowance = () =>
    client.readContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "allowance",
      args: [root.address, PAD],
    });
  const agent = () =>
    new AgentSession({
      client,
      account: root.address,
      keyHash: getProfile("agent", keystore).keyHash,
      signer: loadProfileSigner("agent", keystore),
      executor,
      addresses: book,
    });

  beforeAll(async () => {
    let url: string;
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
    const config: SponsorConfig = {
      // The init batch with the first grant bounds above the default 0.05 MNT per-request cap.
      ...testConfig({ allowlist: [root.address], maxFeePerRequest: parseEther("0.5") }),
      rpcUrl: url,
      database,
      settleTimeoutSeconds: 1,
    };
    store = new SponsorStore(database);
    ledger = new Ledger({ config, client, store, account: RELAYER, pollIntervalMs: 200 });
    await ledger.start();
    server = createSponsorServer({ config, client, store, ledger });
    base = await server.listen();
    // No relayer address given: the executor reads it from the sponsor's /health.
    executor = new RelayerExecutor({
      client,
      url: base,
      addresses: book,
      timeoutMs: 60_000,
      pollIntervalMs: 200,
    });
    account = new MantleAccount({ client, root, executor, addresses: book, keystore });
  }, 120_000);
  afterAll(async () => {
    await server?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    store?.close();
    stop?.();
  });

  it("initialises an undelegated account (type-4 delegation, init batch, first grant) through the sponsor", async () => {
    expect(await executor.relayer()).toBe(RELAYER_ADDRESS);
    expect(await account.state()).toBe("UNDELEGATED");
    const relayerBefore = await client.getBalance({ address: RELAYER_ADDRESS });

    const result = await account.init({ grant: { policy, agentName: "agent" } });

    expect(result.state).toBe("INITIALIZED");
    const receipt = await client.getTransactionReceipt({ hash: result.hash as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    const tx = await client.getTransaction({ hash: result.hash as `0x${string}` });
    expect(tx.type).toBe("eip7702");
    // On-chain effect: the delegation designator, the safe initialisation and the hooked session.
    expect((await client.getCode({ address: root.address }))?.toLowerCase()).toBe(
      delegationDesignator(book.caliburEntry),
    );
    expect(
      await client.readContract({
        address: root.address,
        abi: caliburAbi,
        functionName: "nativeAllowance",
        args: [ERC20ETH],
      }),
    ).toBe(0n);
    const [session] = await account.listSessions();
    expect(session).toMatchObject({
      keyHash: result.session?.keyHash,
      registered: true,
      hooked: true,
      summary: { active: true },
    });
    // The sponsor paid: the root holds no MNT, and the relayer's balance fell.
    expect(await client.getBalance({ address: root.address })).toBe(0n);
    expect(await client.getBalance({ address: RELAYER_ADDRESS })).toBeLessThan(relayerBefore);
  }, 120_000);

  it("runs an agent exec through the sponsor", async () => {
    const result = await agent().exec([approve(123n)], { via: "relayer" });
    expect(result.success).toBe(true);
    expect(await allowance()).toBe(123n);
    const receipt = await client.getTransactionReceipt({ hash: result.hash });
    expect(receipt.from.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
  }, 60_000);

  it("re-posts a pending relay until it settles, and meanwhile the account's next request is busy", async () => {
    const posts = vi.spyOn(globalThis, "fetch");
    await rpc("evm_setAutomine", [false]);
    try {
      const pending = agent().exec([approve(456n)]);
      // The sponsor submits it and answers `pending` after its 1 s settle wait; nothing is mined.
      await sleep(2500);
      const relays = () => posts.mock.calls.filter(([u, i]) => u === base && i?.method === "POST");
      expect(relays().length).toBeGreaterThanOrEqual(2);
      expect(new Set(relays().map(([, i]) => i?.body)).size).toBe(1);

      const busy = await account.exec([approve(1n)]).catch((e: unknown) => e);
      expect(busy).toBeInstanceOf(SponsorBusyError);

      await rpc("evm_mine");
      const result = await pending;
      expect(result.success).toBe(true);
      expect(await allowance()).toBe(456n);
    } finally {
      await rpc("evm_setAutomine", [true]);
      posts.mockRestore();
    }
  }, 60_000);

  it("surfaces the sponsor's own refusal as SponsorRejectedError with its reason", async () => {
    // An approval to an untrusted spender: AgentSession would refuse it locally, so the batch goes
    // to the executor directly and the sponsor's own simulation reverts it.
    const error = await executor
      .submit({
        account: root.address,
        keyHash: getProfile("agent", keystore).keyHash,
        calls: [
          {
            to: USD,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: ["0x00000000000000000000000000000000000b0b00", 1n],
            }),
          },
        ],
        lane: BigInt(getProfile("agent", keystore).keyHash) >> 64n,
        signer: loadProfileSigner("agent", keystore),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect((error as SponsorRejectedError).reason).toBe(SponsorRejectCode.SIMULATION_FAILED);
  }, 60_000);
});
