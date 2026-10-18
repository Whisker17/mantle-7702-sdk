import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  type Call,
  delegationDesignator,
  erc20Abi,
  getProfile,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  RelayerExecutor,
  RuleKind,
  SELECTORS,
} from "@mantle-aa/sdk";
import { encodeFunctionData, toHex, zeroAddress } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFor, mockUsdAbi, RELAYER, startFork } from "../../sdk/test/account/fork.js";
import { startEmbeddedSponsor } from "../src/embedded.js";
import { book, RELAYER_ADDRESS } from "./fixtures.js";

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

// No sponsor service is started: the embedded sponsor runs in this process with its default
// policy, paying with the relayer key the environment holds, and the SDK reaches it only through
// RelayerExecutor.
describe.skipIf(!rpcUrl)("the embedded sponsor on a Mantle Sepolia fork", () => {
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;
  let sponsor: Awaited<ReturnType<typeof startEmbeddedSponsor>>;
  let executor: RelayerExecutor;
  let account: MantleAccount;
  const keystore = {
    home: mkdtempSync(join(tmpdir(), "embedded-fork-")),
    password: "test",
    scrypt: { n: 1024, r: 8, p: 1 },
  };
  const root = new PrivateKeySigner(generatePrivateKey());

  beforeAll(async () => {
    let url: string;
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
    process.env.MANTLE_AA_EMBEDDED_RELAYER = "1";
    process.env.MANTLE_AA_RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);
    sponsor = await startEmbeddedSponsor({
      rpcUrl: url,
      allowlist: [root.address],
      settleTimeoutSeconds: 5,
      pollIntervalMs: 200,
    });
    executor = new RelayerExecutor({
      client,
      url: sponsor.url,
      addresses: book,
      timeoutMs: 60_000,
      pollIntervalMs: 200,
    });
    account = new MantleAccount({ client, root, executor, addresses: book, keystore });
  }, 120_000);
  afterAll(async () => {
    await sponsor?.close().catch(() => undefined);
    stop?.();
    delete process.env.MANTLE_AA_EMBEDDED_RELAYER;
    delete process.env.MANTLE_AA_RELAYER_KEY;
  });

  it("initialises an account with its first grant through the embedded sponsor", async () => {
    expect(sponsor.relayer).toBe(RELAYER_ADDRESS);
    expect(await executor.relayer()).toBe(RELAYER_ADDRESS);
    expect(await account.state()).toBe("UNDELEGATED");

    const result = await account.init({ grant: { policy, agentName: "agent" } });

    expect(result.state).toBe("INITIALIZED");
    const receipt = await client.getTransactionReceipt({ hash: result.hash as `0x${string}` });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    expect((await client.getCode({ address: root.address }))?.toLowerCase()).toBe(
      delegationDesignator(book.caliburEntry),
    );
    const [session] = await account.listSessions();
    expect(session).toMatchObject({ registered: true, hooked: true, summary: { active: true } });
    // The sponsor paid: the root holds no MNT.
    expect(await client.getBalance({ address: root.address })).toBe(0n);
  }, 120_000);

  it("runs an agent exec through the embedded sponsor", async () => {
    const agent = new AgentSession({
      client,
      account: root.address,
      keyHash: getProfile("agent", keystore).keyHash,
      signer: loadProfileSigner("agent", keystore),
      executor,
      addresses: book,
    });
    const result = await agent.exec([approve(123n)], { via: "relayer" });
    expect(result.success).toBe(true);
    const receipt = await client.getTransactionReceipt({ hash: result.hash });
    expect(receipt.from.toLowerCase()).toBe(RELAYER_ADDRESS.toLowerCase());
    expect(
      await client.readContract({
        address: USD,
        abi: mockUsdAbi,
        functionName: "allowance",
        args: [root.address, PAD],
      }),
    ).toBe(123n);
  }, 60_000);
});
