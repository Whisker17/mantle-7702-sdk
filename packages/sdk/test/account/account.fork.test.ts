import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  encodeFunctionData,
  getAddress,
  type Hex,
  maxUint256,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  ERC20ETH,
  type Executor,
  erc20Abi,
  getProfile,
  type KeystoreOptions,
  laneOf,
  launchpadAbi,
  loadDeployments,
  loadProfileSigner,
  MantleAccount,
  type Policy,
  PrivateKeySigner,
  RuleKind,
  readProfiles,
  SELECTORS,
  UndelegationFailedError,
} from "../../src/index.js";
import {
  clientFor,
  mockUsdAbi,
  RELAYER,
  startFork,
  TestRelayer,
  THIRD_PARTY,
  walletFor,
} from "./fork.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const MEME = book.memeToken;
const OTHER_SPENDER = getAddress("0x00000000000000000000000000000000000b0b00");
const usd = (n: number) => BigInt(n) * 10n ** 6n;

const acceptancePolicy = (over: Partial<Policy> = {}): Policy => ({
  maxValuePerCall: 0n,
  mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
  quoteLimits: [{ token: USD, totalCap: usd(1000), periodCap: usd(500) }],
  periodLength: 86400,
  permissions: [
    { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
    { target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
    { target: PAD, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
  ],
  trustedSpenders: [PAD, OTHER_SPENDER],
  maxDeadlineWindow: 600,
  ...over,
});

// Passes every local check, fails on chain: the launchpad's quote asset has no limit.
const unmeteredBuyPolicy = acceptancePolicy({
  quoteLimits: [],
  permissions: [{ target: PAD, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY }],
  trustedSpenders: [],
});

describe.skipIf(!rpcUrl)("MantleAccount on a Mantle Sepolia fork", () => {
  let url: string;
  let stop: () => void;
  let client: ReturnType<typeof clientFor>;

  beforeAll(async () => {
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
  }, 60_000);
  afterAll(() => stop?.());

  const keystore = (): KeystoreOptions => ({
    home: mkdtempSync(join(tmpdir(), "mantle-aa-account-")),
    password: "test",
    scrypt: { n: 1024, r: 8, p: 1 },
  });

  const setup = (executor?: Executor) => {
    const relayer = new TestRelayer(url, book);
    const ks = keystore();
    const root = new PrivateKeySigner(generatePrivateKey());
    const account = new MantleAccount({
      client,
      root,
      executor: executor ?? relayer,
      addresses: book,
      keystore: ks,
    });
    return { relayer, ks, root, account };
  };

  const deadline = async () => (await client.getBlock()).timestamp + 60n;
  const read = (address: Address, functionName: "allowance", args: [Address, Address]) =>
    client.readContract({ address, abi: mockUsdAbi, functionName, args });
  const inventory = (keyHash: Hex, account: Address) =>
    client.readContract({
      address: book.agentPolicyHook,
      abi: agentPolicyHookAbi,
      functionName: "inventory",
      args: [keyHash, account, MEME],
    });
  const reserved = (account: Address) =>
    client.readContract({
      address: book.agentPolicyHook,
      abi: agentPolicyHookAbi,
      functionName: "reserved",
      args: [account, MEME],
    });

  const mintUsd = async (to: Address, amount: bigint) => {
    const wallet = walletFor(url, RELAYER);
    const hash = await wallet.writeContract({
      address: USD,
      abi: mockUsdAbi,
      functionName: "mint",
      args: [to, amount],
    });
    await client.waitForTransactionReceipt({ hash });
  };

  const approve = (spender: Address, amount: bigint): Call => ({
    to: USD,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  });
  const trade = async (fn: "buy" | "sell", account: Address, amount: bigint): Promise<Call> => ({
    to: PAD,
    value: 0n,
    data: encodeFunctionData({
      abi: launchpadAbi,
      functionName: fn,
      args: [MEME, amount, 0n, await deadline(), account],
    }),
  });

  /** An agent's own batch, relayed like the root's but signed by the session key on its lane. */
  const agentExec = async (
    relayer: TestRelayer,
    ks: KeystoreOptions,
    account: Address,
    agent: string,
    calls: Call[],
  ) => {
    const signer = loadProfileSigner(agent, ks);
    const { keyHash } = getProfile(agent, ks);
    return relayer.submit({
      account,
      keyHash,
      calls,
      lane: laneOf(keyHash),
      signer,
      deadline: await deadline(),
    });
  };

  const nativeAllowance = (account: Address) =>
    client.readContract({
      address: account,
      abi: caliburAbi,
      functionName: "nativeAllowance",
      args: [ERC20ETH],
    });

  it("walks UNDELEGATED → DELEGATED → INITIALIZED, retrying after a failed grant", async () => {
    const { relayer, ks, account } = setup();
    expect(await account.state()).toBe("UNDELEGATED");

    // Init + a grant the hook rejects: the batch reverts, the authorization still applies.
    await expect(
      account.init({ grant: { policy: unmeteredBuyPolicy, agentName: "alice" } }),
    ).rejects.toThrow(/the account is DELEGATED; retry init/);
    expect(await account.state()).toBe("DELEGATED");
    expect(await nativeAllowance(account.address)).toBe(maxUint256);
    expect(relayer.requests[0]?.authorization?.chainId).toBe(5003);
    expect(relayer.requests[0]?.keyHash).toBe(`0x${"00".repeat(32)}`);
    expect(relayer.requests[0]?.calls[0]?.data.slice(0, 10)).toBe(
      encodeFunctionData({
        abi: caliburAbi,
        functionName: "approveNative",
        args: [ERC20ETH, 0n],
      }).slice(0, 10),
    );
    expect(readProfiles(ks)).toEqual({}); // the failed grant left no profile
    const failedKey = (await account.listSessions()).length;
    expect(failedKey).toBe(0); // nor a registered key

    // A session cannot be granted before the safe initialisation.
    await expect(account.grantSession(acceptancePolicy(), { agentName: "alice" })).rejects.toThrow(
      /DELEGATED, not INITIALIZED/,
    );

    // Retry: re-reads the state, needs no new authorization, grants a brand-new key.
    const retry = await account.init({ grant: { policy: acceptancePolicy(), agentName: "alice" } });
    expect(retry.state).toBe("INITIALIZED");
    expect(relayer.requests.at(-1)?.authorization).toBeUndefined();
    expect(await nativeAllowance(account.address)).toBe(0n);
    const sessions = await account.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      keyHash: retry.session?.keyHash.toLowerCase(),
      profile: "alice",
      registered: true,
      hooked: true,
      isAdmin: false,
      summary: { initialized: true, active: true, revoked: false },
    });
    expect(loadProfileSigner("alice", ks).address).toBe(retry.session?.address);

    // Initialized: init without a grant is a no-op; with one it is a plain grant.
    expect(await account.init()).toEqual({ state: "INITIALIZED" });
    const requests = relayer.requests.length;
    const second = await account.init({ grant: { policy: acceptancePolicy(), agentName: "bob" } });
    expect(relayer.requests).toHaveLength(requests + 1);
    expect(second.session?.address).not.toBe(retry.session?.address);
  }, 120_000);

  it("finishes init after the authorization was front-run on its own", async () => {
    const { relayer, root, account } = setup();
    // Anyone holding the signed authorization can land it without the init batch.
    const authorization = await root.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: await client.getTransactionCount({ address: root.address }),
    });
    const thirdParty = walletFor(url, THIRD_PARTY);
    const hash = await thirdParty.sendTransaction({
      to: thirdParty.account.address,
      authorizationList: [authorization],
    });
    await client.waitForTransactionReceipt({ hash });
    expect(await account.state()).toBe("DELEGATED");

    expect((await account.init()).state).toBe("INITIALIZED");
    expect(relayer.requests).toHaveLength(1);
    expect(relayer.requests[0]?.authorization).toBeUndefined();
  }, 120_000);

  it("finishes init when its authorization is front-run in flight", async () => {
    const thirdParty = walletFor(url, THIRD_PARTY);
    let inner: TestRelayer | undefined;
    const frontRunning: Executor = {
      kind: "relayer",
      async submit(request) {
        if (request.authorization) {
          const hash = await thirdParty.sendTransaction({
            to: thirdParty.account.address,
            authorizationList: [request.authorization],
          });
          await client.waitForTransactionReceipt({ hash });
        }
        return (inner as TestRelayer).submit(request);
      },
    };
    const { relayer, account } = setup(frontRunning);
    inner = relayer;
    const result = await account.init({
      grant: { policy: acceptancePolicy(), agentName: "alice" },
    });
    // The stale authorization in the init transaction is skipped; the batch still runs.
    expect(result.state).toBe("INITIALIZED");
    expect((await account.listSessions())[0]?.summary.active).toBe(true);
  }, 120_000);

  it("grants, updates (resetting removed allowances), revokes and reports sessions", async () => {
    const { relayer, ks, account } = setup();
    const { session } = await account.init({
      grant: { policy: acceptancePolicy(), agentName: "alice" },
    });
    const keyHash = session?.keyHash as Hex;
    await mintUsd(account.address, usd(100));

    // The agent approves both trusted spenders.
    const approved = await agentExec(relayer, ks, account.address, "alice", [
      approve(OTHER_SPENDER, usd(5)),
      approve(PAD, usd(3)),
    ]);
    expect(approved.success).toBe(true);
    expect(await read(USD, "allowance", [account.address, OTHER_SPENDER])).toBe(usd(5));

    // Raising a cap is refused before anything is signed.
    const before = relayer.requests.length;
    await expect(
      account.updateSession(
        keyHash,
        acceptancePolicy({ quoteLimits: [{ token: USD, totalCap: usd(2000), periodCap: usd(1) }] }),
      ),
    ).rejects.toThrow(/raised/);
    expect(relayer.requests).toHaveLength(before);

    // Dropping a spender resets exactly that pair's allowance.
    const updated = await account.updateSession(
      keyHash,
      acceptancePolicy({
        quoteLimits: [{ token: USD, totalCap: usd(900), periodCap: usd(400) }],
        trustedSpenders: [PAD],
      }),
    );
    expect(updated.resetAllowances).toEqual([{ token: USD, spender: OTHER_SPENDER }]);
    expect(await read(USD, "allowance", [account.address, OTHER_SPENDER])).toBe(0n);
    expect(await read(USD, "allowance", [account.address, PAD])).toBe(usd(3));

    const status = await account.status();
    expect(status.state).toBe("INITIALIZED");
    expect(status.caliburNonce).toBe(2n); // init, update
    expect(status.sessions[0]?.policy?.trustedSpenders).toEqual([PAD]);
    expect(status.sessions[0]?.remaining).toEqual([{ token: USD, amount: usd(400) }]);
    expect(status.sessions[0]?.expiry).toBe(session?.expiry);

    // Revoke: Calibur key, hook tombstone and the remaining allowances.
    const revoked = await account.revokeSession(keyHash);
    expect(revoked.resetAllowances).toEqual([{ token: USD, spender: PAD }]);
    expect(await read(USD, "allowance", [account.address, PAD])).toBe(0n);
    const [info] = await account.listSessions();
    expect(info).toMatchObject({
      profile: "alice",
      registered: false,
      summary: { initialized: true, active: false, revoked: true },
    });
    expect(
      (await agentExec(relayer, ks, account.address, "alice", [approve(PAD, 1n)])).success,
    ).toBe(false);
    await expect(account.updateSession(keyHash, acceptancePolicy())).rejects.toThrow(
      /not a hooked/,
    );
  }, 180_000);

  it("releases only the named key's inventory on a root disposal", async () => {
    const { relayer, ks, account } = setup();
    const a = (await account.init({ grant: { policy: acceptancePolicy(), agentName: "a" } }))
      .session?.keyHash as Hex;
    const b = (await account.grantSession(acceptancePolicy(), { agentName: "b" })).keyHash;
    await mintUsd(account.address, usd(100));
    const me = account.address;

    // Each session buys; the root buys an unallocated position of the same token.
    const buy = async (agent: string, amount: bigint) =>
      agentExec(relayer, ks, me, agent, [approve(PAD, amount), await trade("buy", me, amount)]);
    expect((await buy("a", usd(2))).success).toBe(true);
    expect((await buy("b", usd(1))).success).toBe(true);
    await account.exec([approve(PAD, usd(4)), await trade("buy", me, usd(4))]);
    const unit = 10n ** 21n; // MockLaunchpad: 1 mUSD buys 1e21 meme units
    expect(await inventory(a, me)).toBe(2n * unit);
    expect(await inventory(b, me)).toBe(unit);
    expect(await reserved(me)).toBe(3n * unit);

    // Over-releasing a key is refused locally; nothing is submitted.
    const before = relayer.requests.length;
    await expect(
      account.exec([await trade("sell", me, 3n * unit)], {
        release: [{ keyHash: a, token: MEME, amount: 3n * unit }],
      }),
    ).rejects.toThrow(/exceeds/);
    expect(relayer.requests).toHaveLength(before);

    // Disposing of meme without a release tuple warns about the ledger obligation.
    const unallocated = await account.exec([await trade("sell", me, unit)]);
    expect(unallocated.warnings).toHaveLength(1);

    // Release 1.5e21 from key a with the disposal: b and the unallocated balance are untouched.
    const amount = (3n * unit) / 2n;
    const released = await account.exec([await trade("sell", me, amount)], {
      release: [{ keyHash: a, token: MEME, amount }],
    });
    expect(released.warnings).toEqual([]);
    expect(relayer.requests.at(-1)?.calls[0]?.to).toBe(book.agentPolicyHook); // release first
    expect(await inventory(a, me)).toBe(2n * unit - amount);
    expect(await inventory(b, me)).toBe(unit);
    const status = await account.status();
    expect(status.inventory).toEqual([
      {
        token: MEME,
        balance: 6n * unit - amount,
        reserved: 3n * unit - amount,
        unallocated: 3n * unit,
      },
    ]);
    const amounts = Object.fromEntries(
      status.sessions.map((s) => [s.profile, s.inventory[0]?.amount]),
    );
    expect(amounts).toEqual({ a: 2n * unit - amount, b: unit });

    // No attribution gap: session b can still sell its own position.
    expect((await agentExec(relayer, ks, me, "b", [await trade("sell", me, unit)])).success).toBe(
      true,
    );
  }, 180_000);

  it("panic --self-pay --undelegate: a phase 2 whose authorization does not apply fails as such, and a retry finishes it", async () => {
    // The root signs its undelegation with a stale nonce: the chain skips the authorization and
    // the transaction still succeeds, leaving the account delegated.
    class StaleAuthorization extends PrivateKeySigner {
      stale = false;
      override signAuthorization(params: Parameters<PrivateKeySigner["signAuthorization"]>[0]) {
        return super.signAuthorization(
          this.stale ? { ...params, nonce: (params.nonce ?? 0) + 7 } : params,
        );
      }
    }
    const root = new StaleAuthorization(generatePrivateKey());
    const relayer = new TestRelayer(url, book);
    const account = new MantleAccount({
      client,
      root,
      executor: relayer,
      addresses: book,
      keystore: keystore(),
    });
    const keyHash = (await account.init({ grant: { policy: acceptancePolicy(), agentName: "a" } }))
      .session?.keyHash as Hex;
    await client.request({
      method: "anvil_setBalance",
      params: [account.address, toHex(10n ** 18n)],
    } as never);
    const sponsored = relayer.requests.length;

    root.stale = true;
    const failed = await account.panic({ selfPay: true, undelegate: true }).catch((e) => e);
    expect(failed).toBeInstanceOf(UndelegationFailedError);
    expect(failed.message).toMatch(
      /^Revocation \(phase 1\) confirmed in transaction 0x[0-9a-f]{64}; undelegation \(phase 2\) failed: transaction 0x[0-9a-f]{64} left the account delegated/,
    );
    expect(failed.revocation).toMatchObject({ status: "confirmed", revokedKeys: [keyHash] });
    // Phase 1 landed, self-paid: nothing went through the relayer.
    expect(relayer.requests).toHaveLength(sponsored);
    const receipt = await client.getTransactionReceipt({ hash: failed.revocation.hash });
    expect(receipt.from).toBe(account.address.toLowerCase());
    expect(receipt.to).toBe(account.address.toLowerCase());
    expect(await account.state()).toBe("INITIALIZED");
    const [info] = await account.listSessions();
    expect(info).toMatchObject({ registered: false, summary: { active: false, revoked: true } });

    // The retry has nothing left to revoke and only sends phase 2.
    root.stale = false;
    const retried = await account.panic({ selfPay: true, undelegate: true });
    expect(retried.revocation).toEqual({
      status: "nothing-to-revoke",
      hash: null,
      revokedKeys: [],
      resetAllowances: [],
    });
    expect(retried.undelegation?.status).toBe("confirmed");
    expect(await account.state()).toBe("UNDELEGATED");
    expect(relayer.requests).toHaveLength(sponsored);
  }, 180_000);
});
