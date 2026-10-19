import {
  AgentSession,
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  launchpadAbi,
  loadDeployments,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  RuleKind,
  readProfiles,
  SELECTORS,
} from "@mantle-aa/sdk";
import { relayerFeeBound } from "@mantle-aa/sponsor";
import {
  type Address,
  concat,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  numberToHex,
  size,
  toHex,
  zeroAddress,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  mockUsdAbi,
  RELAYER,
  startFork,
  TestRelayer,
  THIRD_PARTY,
  walletFor,
} from "../../sdk/test/account/fork.js";
import { cli, normalize, PASSWORD, tempHome, testEnv } from "./helpers.js";

// `account panic` at the worst-case size of docs/DESIGN.md §4.2.3 on an anvil fork of Mantle
// Sepolia: 8 sessions × 4 quote assets × 4 trusted spenders, no pair shared, so 8 Calibur revokes,
// 8 hook tombstones and 128 allowance resets in one transaction. Measured once through the
// (embedded) sponsor and once self-paid with the sponsor unreachable, followed by the undelegation.
// Skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const usd = (n: number) => BigInt(n) * 10n ** 6n;
/** The embedded sponsor's relayer: anvil account 3. */
const EMBEDDED_RELAYER = mnemonicToAccount(
  "test test test test test test test test test test test junk",
  { addressIndex: 3 },
);
const EMBEDDED_RELAYER_KEY = toHex(EMBEDDED_RELAYER.getHdKey().privateKey as Uint8Array);
const SESSIONS = 8;
const SPENDERS = [PAD, ...[1, 2, 3].map((i) => getAddress(`0x${"5e".repeat(19)}0${i}`))];
/** Nothing listens on port 1: a sponsor that refuses every connection. */
const DOWN_SPONSOR = "http://127.0.0.1:1";

describe.skipIf(!rpcUrl)("account panic on a Mantle Sepolia fork", () => {
  let anvil: string;
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;
  let account: Address;
  let tokens: Address[];
  let snapshot: unknown;
  const home = tempHome();
  const env = testEnv(home);
  const rpc = (method: string, params: unknown[] = []) =>
    client.request({ method, params } as never) as Promise<unknown>;

  /** `mantle-aa <args> --json`; its output never carries the password or a relayer key. */
  async function panicCli(args: string[], extra: Record<string, string>) {
    const r = await cli(args, { ...env, MANTLE_AA_RPC_URL: anvil, ...extra });
    for (const secret of [PASSWORD, EMBEDDED_RELAYER_KEY.slice(2)]) {
      expect(r.stdout + r.stderr).not.toContain(secret);
    }
    return r;
  }
  const allowances = () =>
    Promise.all(
      tokens.flatMap((token) =>
        SPENDERS.map((spender) =>
          client.readContract({
            address: token,
            abi: mockUsdAbi,
            functionName: "allowance",
            args: [account, spender],
          }),
        ),
      ),
    );
  const keyCount = () =>
    client.readContract({ address: account, abi: caliburAbi, functionName: "keyCount" });
  /** The panic transaction's gas, and the fee the sponsor's relayer bound puts on it. */
  async function measure(hash: Hex) {
    const [receipt, tx, block] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
      client.getBlock(),
    ]);
    const feeBound = await relayerFeeBound(client, book.chainId, {
      to: tx.to as Address,
      data: tx.input,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas as bigint,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas as bigint,
    });
    return {
      gasUsed: receipt.gasUsed,
      gasLimit: tx.gas,
      calldataBytes: size(tx.input),
      relayerFeeBoundWei: feeBound,
      blockGasLimit: block.gasLimit,
    };
  }

  beforeAll(async () => {
    ({ url: anvil, stop } = await startFork(rpcUrl as string));
    client = clientFor(anvil);
    expect((await cli(["keys", "new", "--name", "root"], env)).code).toBe(0);
    const ks = {
      home: env.MANTLE_AA_HOME as string,
      password: PASSWORD,
      scrypt: { n: 1024, r: 8, p: 1 },
    };
    const relayer = new TestRelayer(anvil, book);
    const root = new MantleAccount({
      client,
      root: loadProfileSigner("root", ks),
      executor: relayer,
      addresses: book,
      keystore: ks,
    });
    account = root.address;

    // 32 quote assets: MockUSD and 31 copies of its code, deployed by a returning constructor.
    const code = (await client.getCode({ address: USD })) as Hex;
    const deployer = walletFor(anvil, THIRD_PARTY);
    const initCode = concat([
      `0x61${numberToHex(size(code), { size: 2 }).slice(2)}80600c6000396000f3`,
      code,
    ]);
    const nonce = await client.getTransactionCount({ address: THIRD_PARTY.address });
    const deployed = await Promise.all(
      Array.from({ length: SESSIONS * 4 - 1 }, async (_, i) => {
        const hash = await deployer.sendTransaction({
          data: initCode,
          to: null,
          nonce: nonce + i,
          gas: 1_000_000n,
        });
        return (await client.waitForTransactionReceipt({ hash, timeout: 30_000 })).contractAddress;
      }),
    );
    tokens = [USD, ...(deployed as Address[])];

    // Session i limits tokens 4i…4i+3 for the same four spenders: 8 × 16 distinct pairs. Session 0
    // is also the acceptance policy (MockUSD approve, launchpad buy / sell) so it can hold meme.
    const policy = (i: number): Policy => ({
      maxValuePerCall: 0n,
      mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
      quoteLimits: tokens
        .slice(4 * i, 4 * i + 4)
        .map((token) => ({ token, totalCap: usd(1000), periodCap: usd(500) })),
      periodLength: 86400,
      permissions:
        i === 0
          ? [
              { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
              { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
              { target: PAD, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
            ]
          : [],
      trustedSpenders: SPENDERS,
      maxDeadlineWindow: 600,
    });
    await root.init({ grant: { policy: policy(0), agentName: "agent0" } });
    for (let i = 1; i < SESSIONS; i++) {
      await root.grantSession(policy(i), { agentName: `agent${i}` });
    }

    // Session 0 buys meme: inventory the panic must leave frozen.
    const mint = await walletFor(anvil, RELAYER).writeContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [account, usd(100)],
    });
    await client.waitForTransactionReceipt({ hash: mint, timeout: 30_000 });
    const profile = readProfiles(ks).agent0;
    const agent = new AgentSession({
      client,
      account,
      keyHash: profile?.keyHash as Hex,
      signer: loadProfileSigner("agent0", ks),
      addresses: book,
      executor: relayer,
    });
    const { timestamp } = await client.getBlock();
    const approve = (token: Address, spender: Address, amount: bigint): Call => ({
      to: token,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    });
    await agent.exec([
      approve(USD, PAD, usd(10)),
      {
        to: PAD,
        value: 0n,
        data: encodeFunctionData({
          abi: launchpadAbi,
          functionName: "buy",
          args: [MEME, usd(10), 0n, timestamp + 60n, account],
        }),
      },
    ]);

    // Every pair holds a live allowance, so each reset is a non-zero → zero write.
    const all = tokens.flatMap((t) => SPENDERS.map((s) => approve(t, s, 1n)));
    await root.exec(all.slice(0, 64));
    await root.exec(all.slice(64));
    expect(await allowances()).toEqual(all.map(() => 1n));
    expect(await keyCount()).toBe(BigInt(SESSIONS));
    snapshot = await rpc("evm_snapshot");
  }, 600_000);
  afterAll(() => stop?.());

  it("worst case through the sponsor: 8 revokes, 8 tombstones, 128 resets in one transaction", async () => {
    const r = await panicCli(["account", "panic"], {
      MANTLE_AA_EMBEDDED_RELAYER: "1",
      MANTLE_AA_RELAYER_KEY: EMBEDDED_RELAYER_KEY,
    });
    expect(r.code, r.stdout).toBe(0);
    const { revocation, undelegation } = r.json.result;
    expect(revocation.status).toBe("confirmed");
    expect(revocation.revokedKeys).toHaveLength(SESSIONS);
    expect(revocation.resetAllowances).toHaveLength(SESSIONS * 16);
    expect(undelegation).toBeNull();
    const tx = await client.getTransaction({ hash: revocation.hash });
    expect(tx.from).toBe(EMBEDDED_RELAYER.address.toLowerCase());
    const gas = await measure(revocation.hash);
    console.log("panic worst case, sponsored relayer path:", gas);
    expect(gas.gasUsed).toBeLessThan(gas.blockGasLimit);

    expect(new Set(await allowances())).toEqual(new Set([0n]));
    expect(await keyCount()).toBe(0n);
    for (const keyHash of revocation.revokedKeys) {
      const summary = await client.readContract({
        address: book.agentPolicyHook,
        abi: agentPolicyHookAbi,
        functionName: "getSummary",
        args: [keyHash, account],
      });
      expect(summary).toMatchObject({ active: false, revoked: true });
    }
    expect(await rpc("evm_revert", [snapshot])).toBe(true);
  }, 300_000);

  it("with the sponsor down: --self-pay --undelegate revokes, then undelegates; status shows frozen inventory", async () => {
    const down = { MANTLE_AA_SPONSOR_URL: DOWN_SPONSOR };
    // The sponsor really is unreachable: the sponsored panic fails before anything is sent.
    const refused = await panicCli(["account", "panic"], down);
    expect(refused.code).toBe(1);
    expect(refused.json.error.message).toMatch(
      /^Revocation \(phase 1\) not confirmed: Sponsor unreachable: .*rerun account panic \(with --self-pay/,
    );
    // Self-paid, the root needs MNT for gas.
    expect(await client.getBalance({ address: account })).toBe(0n);
    const unfunded = await panicCli(["account", "panic", "--self-pay"], down);
    expect(unfunded.code).toBe(1);
    expect(unfunded.json.error.message).toMatch(
      /^Revocation \(phase 1\) not confirmed: .*exceeds the balance of the account/,
    );
    expect(await keyCount()).toBe(BigInt(SESSIONS));

    await rpc("anvil_setBalance", [account, toHex(10n ** 18n)]);
    const r = await panicCli(["account", "panic", "--self-pay", "--undelegate"], down);
    expect(r.code, r.stdout).toBe(0);
    const { revocation, undelegation, recovery } = r.json.result;
    expect(
      normalize(
        {
          revocation: { ...revocation, revokedKeys: [], resetAllowances: [] },
          undelegation,
          recovery,
        },
        home,
      ),
    ).toMatchSnapshot();
    expect(revocation.revokedKeys).toHaveLength(SESSIONS);
    expect(revocation.resetAllowances).toHaveLength(SESSIONS * 16);

    // Phase 1: the root's own transaction to itself; phase 2 only after it, in a later block.
    const [phase1, phase2] = await Promise.all(
      [revocation.hash, undelegation.hash].map((hash) => client.getTransactionReceipt({ hash })),
    );
    expect(phase1).toMatchObject({
      status: "success",
      from: account.toLowerCase(),
      to: account.toLowerCase(),
    });
    expect(phase2).toMatchObject({ status: "success", type: "eip7702" });
    expect(phase2?.blockNumber).toBeGreaterThan(phase1?.blockNumber as bigint);
    console.log("panic worst case, self-paid:", await measure(revocation.hash));
    expect(await client.getCode({ address: account })).toBeUndefined();
    expect(new Set(await allowances())).toEqual(new Set([0n]));

    // Undelegated: the hook still holds every tombstone and session 0's frozen meme.
    const status = await panicCli(["account", "status"], down);
    expect(status.code).toBe(0);
    const { state, sessions, inventory } = status.json.result;
    expect(state).toBe("UNDELEGATED");
    expect(sessions).toHaveLength(SESSIONS);
    for (const s of sessions) {
      expect(s).toMatchObject({ registered: false, summary: { active: false, revoked: true } });
    }
    const held = BigInt(
      sessions.find((s: { profile: string }) => s.profile === "agent0").inventory[0].amount,
    );
    expect(held).toBeGreaterThan(0n);
    expect(inventory).toEqual([
      { token: MEME, balance: held.toString(), reserved: held.toString(), unallocated: "0" },
    ]);
  }, 300_000);
});
