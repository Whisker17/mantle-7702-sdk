import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  BundlerExecutor,
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
  RuleKind,
  SELECTORS,
} from "@mantle-aa/sdk";
import {
  encodeFunctionData,
  type Hex,
  parseEther,
  parseEventLogs,
  toHex,
  erc20Abi as viemErc20Abi,
  zeroAddress,
} from "viem";
import { entryPoint08Abi } from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BundlerStack,
  setPaymasterSigner,
  startBundlerStack,
} from "../../../e2e/bundler/harness.js";
import type { SponsorConfig } from "../src/config.js";
import { startSponsor } from "../src/main.js";
import { SponsorStore } from "../src/store.js";
import { book, testConfig } from "./fixtures.js";

// Forks Mantle Sepolia with anvil and runs the pinned, patched Alto in safe mode on it
// (e2e/bundler/harness.ts); skipped when MANTLE_SEPOLIA_RPC_URL is unset. The deployed
// VerifyingPaymaster sponsors every op, its signer swapped on the fork for a key the sponsor holds.
// The SDK reaches the sponsor and the bundler only through BundlerExecutor. This test lives with the
// sponsor because the sponsor depends on the SDK.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const SIGNER_ENV = "BUNDLER_EXECUTOR_FORK_TEST_SIGNER_KEY";
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const PM = book.verifyingPaymaster;

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

describe.skipIf(!rpcUrl)("BundlerExecutor through strict Alto on a Mantle Sepolia fork", () => {
  let stack: BundlerStack;
  let sponsor: Awaited<ReturnType<typeof startSponsor>>;
  let store: SponsorStore;
  let executor: BundlerExecutor;
  let account: MantleAccount;
  const dir = mkdtempSync(join(tmpdir(), "bundler-executor-fork-"));
  const keystore = { home: dir, password: "test", scrypt: { n: 1024, r: 8, p: 1 } };
  const root = new PrivateKeySigner(generatePrivateKey());

  beforeAll(async () => {
    stack = await startBundlerStack(rpcUrl as string);
    const signerKey = generatePrivateKey();
    await setPaymasterSigner(stack.client, PM, privateKeyToAddress(signerKey));
    process.env[SIGNER_ENV] = signerKey;
    const config: SponsorConfig = {
      // The init op with the first grant bounds above the default 0.05 MNT per-request cap.
      ...testConfig({ allowlist: [root.address], maxFeePerRequest: parseEther("1") }),
      rpcUrl: stack.rpcUrl,
      database: join(dir, "sponsor.sqlite"),
      paymasterSignerKeyEnv: SIGNER_ENV,
    };
    // The reconcile loop never runs during the test: a sponsorship settles only when the account's
    // next request finds its UserOp included, as a client asking right after the bundler does.
    sponsor = await startSponsor(config, { pollIntervalMs: 3_600_000 });
    store = new SponsorStore(config.database);
    // No sponsor address given: the executor reads it from the sponsor's /health.
    executor = new BundlerExecutor({
      client: stack.client,
      bundlerUrl: stack.bundler.url,
      sponsorUrl: sponsor.url,
      addresses: book,
      timeoutMs: 60_000,
      pollIntervalMs: 200,
    });
    account = new MantleAccount({
      client: stack.client,
      root,
      executor,
      addresses: book,
      keystore,
    });
  }, 360_000);
  afterAll(async () => {
    await sponsor?.close();
    store?.close();
    await stack?.stop();
    delete process.env[SIGNER_ENV];
  }, 30_000);

  /** The bundle's one UserOperationEvent: sponsored by the deployed paymaster, sent by Alto. */
  const userOpEvent = async (hash: Hex) => {
    const receipt = await stack.client.getTransactionReceipt({ hash });
    expect(stack.bundler.executors).toContain(receipt.from.toLowerCase());
    const events = parseEventLogs({
      abi: entryPoint08Abi,
      eventName: "UserOperationEvent",
      logs: receipt.logs,
    });
    expect(events).toHaveLength(1);
    const { args } = events[0] as (typeof events)[number];
    console.log(
      `UserOp nonce ${toHex(args.nonce)}: actualGasUsed ${args.actualGasUsed}, actualGasCost ${args.actualGasCost}, bundle gasUsed ${receipt.gasUsed}`,
    );
    return args;
  };
  let initCost: bigint;

  it("initialises an undelegated account (root init UserOp with eip7702Auth, first grant) through the bundler", async () => {
    expect(await account.state()).toBe("UNDELEGATED");
    const sent = Date.now();
    const result = await account.init({ grant: { policy, agentName: "agent" } });

    expect(result.state).toBe("INITIALIZED");
    const hash = result.hash as Hex;
    const tx = await stack.client.getTransaction({ hash });
    expect(tx.type).toBe("eip7702");
    expect(tx.to?.toLowerCase()).toBe(book.entryPoint.toLowerCase());
    const event = await userOpEvent(hash);
    expect(event).toMatchObject({ sender: root.address, paymaster: PM, success: true, nonce: 0n });
    initCost = event.actualGasCost;
    // Accepted through safe-mode validation: Alto traced it with its ERC-7562 collector.
    await stack.bundler.traced(root.address, sent);
    expect((await stack.client.getCode({ address: root.address }))?.toLowerCase()).toBe(
      delegationDesignator(book.caliburEntry),
    );
    expect(
      await stack.client.readContract({
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
    // The paymaster paid: the root holds no MNT. The sponsorship stays open until the next request.
    expect(await stack.client.getBalance({ address: root.address })).toBe(0n);
    expect(store.entries()).toMatchObject([
      { state: "submitted", budgetClass: "management", account: root.address },
    ]);
  }, 180_000);

  it("runs an agent exec right after the init, as a session UserOp on the key's own lane through the bundler", async () => {
    const keyHash = getProfile("agent", keystore).keyHash;
    const agent = new AgentSession({
      client: stack.client,
      account: root.address,
      keyHash,
      signer: loadProfileSigner("agent", keystore),
      executor,
      addresses: book,
    });
    const lane = BigInt(keyHash) >> 64n;

    const sent = Date.now();
    const result = await agent.exec([approve(123n)], { via: "bundler" });

    expect(result.success).toBe(true);
    // Accepted through safe-mode validation, as the init.
    await stack.bundler.traced(root.address, sent);
    const tx = await stack.client.getTransaction({ hash: result.hash });
    expect(tx.type).not.toBe("eip7702");
    expect(await userOpEvent(result.hash)).toMatchObject({
      sender: root.address,
      paymaster: PM,
      success: true,
      nonce: lane << 64n,
    });
    expect(
      await stack.client.readContract({
        address: USD,
        abi: viemErc20Abi,
        functionName: "allowance",
        args: [root.address, PAD],
      }),
    ).toBe(123n);
    // Asking for this op settled the init's sponsorship with what the EntryPoint charged.
    expect(store.entries()).toMatchObject([
      {
        state: "settled",
        budgetClass: "management",
        reserved: { gas: 0n, fee: 0n },
        charged: { fee: initCost },
        paymaster: { included: { success: true, actualGasCost: String(initCost) } },
      },
      { state: "submitted", budgetClass: "business" },
    ]);
  }, 120_000);
});
