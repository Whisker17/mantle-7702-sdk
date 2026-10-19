import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Call,
  caliburAbi,
  delegationDesignator,
  ERC20ETH,
  encodeUserOpCallData,
  erc20Abi,
  getProfile,
  laneOf,
  loadProfileSigner,
  MantleAccount,
  type PaymasterMethod,
  type PaymasterUserOperation,
  PM_GET_PAYMASTER_DATA_METHOD,
  PM_GET_PAYMASTER_STUB_DATA_METHOD,
  type Policy,
  PrivateKeySigner,
  paymasterRequestParams,
  ROOT_KEY_HASH,
  RuleKind,
  SELECTORS,
  type Signer,
  signPaymasterRequest,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  pad,
  parseAbi,
  parseEther,
  parseEventLogs,
  type SignedAuthorization,
  zeroAddress,
} from "viem";
import {
  entryPoint08Abi,
  getUserOperationTypedData,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  startFork,
  TestRelayer,
  THIRD_PARTY,
  walletFor,
} from "../../sdk/test/account/fork.js";
import type { SponsorConfig } from "../src/config.js";
import { startSponsor } from "../src/main.js";
import { PAYMASTER_VERIFICATION_GAS, paymasterHash, STUB_SIGNATURE } from "../src/paymaster.js";
import { dayOf, type LedgerEntry, SponsorStore } from "../src/store.js";
import { book, nowSeconds, RELAYER_ADDRESS, testConfig } from "./fixtures.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset. The deployed
// VerifyingPaymaster validates every sponsorship. Without its signer key in
// MANTLE_AA_PAYMASTER_SIGNER_KEY (CI), the fork's copy has that one immutable swapped for a test
// signer's address; the rest of its runtime code, its address and its deposit are the deployed ones.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const realSignerKey = process.env.MANTLE_AA_PAYMASTER_SIGNER_KEY as Hex | undefined;
const SIGNER_ENV = "PAYMASTER_FORK_TEST_SIGNER_KEY";
const DEPLOYED_SIGNER = getAddress("0x7223c837518A51eF0f6c40d67B539D1Aa29a67E9");
const USD = book.mockUsd;
const PAD = book.mockLaunchpad;
const EP = book.entryPoint;
const PM = book.verifyingPaymaster;

const paymasterAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function getHash(PackedUserOperation userOp, uint48 validUntil, uint48 validAfter) view returns (bytes32)",
  "function validatePaymasterUserOp(PackedUserOperation userOp, bytes32 userOpHash, uint256 maxCost) returns (bytes context, uint256 validationData)",
  "function verifyingSigner() view returns (address)",
]);

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

interface Rpc<T> {
  result?: T;
  error?: { code: number; data?: { reason: string; detail: string } };
}
interface PmResult {
  paymaster: Address;
  paymasterData: Hex;
  paymasterVerificationGasLimit: Hex;
  paymasterPostOpGasLimit: Hex;
  isFinal?: boolean;
}

describe.skipIf(!rpcUrl)("paymaster signing on a Mantle Sepolia fork", () => {
  let stop: () => void;
  let url: string;
  let client: ReturnType<typeof clientFor>;
  let sponsor: Awaited<ReturnType<typeof startSponsor>>;
  let store: SponsorStore;
  let config: SponsorConfig;
  const dir = mkdtempSync(join(tmpdir(), "paymaster-fork-"));
  const keystore = { home: dir, password: "test", scrypt: { n: 1024, r: 8, p: 1 } };
  const root = new PrivateKeySigner(generatePrivateKey());
  const freshKey = generatePrivateKey();
  const fresh = new PrivateKeySigner(freshKey);
  let session: Signer;
  let keyHash: Hex;

  beforeAll(async () => {
    ({ url, stop } = await startFork(rpcUrl as string));
    client = clientFor(url);
    const signerKey = realSignerKey ?? generatePrivateKey();
    const signer = privateKeyToAccount(signerKey).address;
    if (realSignerKey) {
      expect(signer).toBe(DEPLOYED_SIGNER);
    } else {
      const code = (await client.getCode({ address: PM })) as Hex;
      const word = (a: Address) => pad(a.toLowerCase() as Hex).slice(2);
      expect(code.split(word(DEPLOYED_SIGNER)).length).toBeGreaterThan(1);
      await client.request({
        method: "anvil_setCode" as never,
        params: [PM, code.replaceAll(word(DEPLOYED_SIGNER), word(signer))] as never,
      });
    }
    expect(
      await client.readContract({
        address: PM,
        abi: paymasterAbi,
        functionName: "verifyingSigner",
      }),
    ).toBe(signer);

    const account = new MantleAccount({
      client,
      root,
      executor: new TestRelayer(url, book),
      addresses: book,
      keystore,
    });
    await account.init({ grant: { policy, agentName: "agent" } });
    session = loadProfileSigner("agent", keystore);
    keyHash = getProfile("agent", keystore).keyHash;

    process.env[SIGNER_ENV] = signerKey;
    config = {
      ...testConfig({
        allowlist: [root.address, fresh.address],
        maxFeePerRequest: parseEther("1"),
      }),
      rpcUrl: url,
      database: join(dir, "sponsor.sqlite"),
      paymasterSignerKeyEnv: SIGNER_ENV,
    };
    sponsor = await startSponsor(config, { pollIntervalMs: 200 });
    store = new SponsorStore(config.database);
  }, 180_000);
  afterAll(async () => {
    await sponsor?.close();
    store?.close();
    stop?.();
    delete process.env[SIGNER_ENV];
  }, 30_000);

  const call = async <T>(method: string, params: unknown): Promise<Rpc<T>> => {
    const res = await fetch(sponsor.url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as Rpc<T>;
  };
  const params = async (
    method: PaymasterMethod,
    signer: Signer,
    userOp: PaymasterUserOperation,
    keyHashOf: Hex,
    validUntil = nowSeconds() + 120,
  ) =>
    paymasterRequestParams(
      await signPaymasterRequest(signer, method, {
        userOp,
        entryPoint: EP,
        chainId: 5003,
        auth: {
          sponsor: RELAYER_ADDRESS,
          keyHash: keyHashOf,
          validAfter: nowSeconds() - 5,
          validUntil,
        },
      }),
    );
  const fees = async () => {
    const { baseFeePerGas } = await client.getBlock();
    return { maxFeePerGas: (baseFeePerGas as bigint) * 2n, maxPriorityFeePerGas: 1_000_000n };
  };
  const nonceOf = (sender: Address, key: bigint) =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "getNonce",
      args: [sender, key],
    });
  const withPaymaster = (op: PaymasterUserOperation, r: PmResult) => ({
    ...op,
    paymaster: r.paymaster,
    paymasterData: r.paymasterData,
    paymasterVerificationGasLimit: BigInt(r.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: BigInt(r.paymasterPostOpGasLimit),
    signature: "0x" as Hex,
  });
  /** The account signs last: the v0.8 userOpHash is EIP-712, so any Signer signs it as typed data. */
  const accountSignature = (signer: Signer, op: ReturnType<typeof withPaymaster>) =>
    signer.signTypedData(
      getUserOperationTypedData({
        chainId: 5003,
        entryPointAddress: EP,
        userOperation: op,
      }) as never,
    );
  /** Sends the UserOp through EntryPoint v0.8 `handleOps` as a bundler would. */
  const handleOps = async (
    op: ReturnType<typeof withPaymaster>,
    authorization?: SignedAuthorization,
  ) => {
    const wallet = walletFor(url, THIRD_PARTY);
    const hash = await wallet.sendTransaction({
      to: EP,
      data: encodeFunctionData({
        abi: entryPoint08Abi,
        functionName: "handleOps",
        args: [[toPackedUserOperation(op)], THIRD_PARTY.address],
      }),
      gas: 2_000_000n,
      ...(authorization ? { authorizationList: [authorization] } : {}),
    });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    expect(receipt.status).toBe("success");
    const [event] = parseEventLogs({
      abi: entryPoint08Abi,
      eventName: "UserOperationEvent",
      logs: receipt.logs,
    });
    expect(event, "UserOperationEvent").toBeDefined();
    return event as NonNullable<typeof event>;
  };
  const deposit = () =>
    client.readContract({
      address: EP,
      abi: entryPoint08Abi,
      functionName: "balanceOf",
      args: [PM],
    });
  /**
   * The deployed paymaster's validation of `op` succeeds, within the gas the sponsor signs for
   * (`eth_estimateGas` from the EntryPoint is an upper bound: it adds the 21 000 base and calldata).
   */
  const expectValidationFits = async (label: string, op: ReturnType<typeof withPaymaster>) => {
    const call = {
      account: EP,
      address: PM,
      abi: paymasterAbi,
      functionName: "validatePaymasterUserOp",
      args: [toPackedUserOperation(op), `0x${"00".repeat(32)}`, 0n],
    } as const;
    const [context, validationData] = (await client.simulateContract(call)).result;
    expect([context, validationData & 1n]).toEqual(["0x", 0n]);
    const gas = await client.estimateContractGas(call);
    console.log(`paymaster validation (${label} UserOp): eth_estimateGas ${gas}`);
    expect(gas - 21_000n).toBeLessThan(PAYMASTER_VERIFICATION_GAS);
  };
  /** The sponsor's ledger entry for a sponsorship, once its state leaves `submitted` (≤ 20 s). */
  const settled = async (paymasterData: Hex): Promise<LedgerEntry> => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const entry = store
        .entries()
        .find((e) => e.paymaster?.result.paymasterData === paymasterData);
      if (entry && entry.state !== "submitted") return entry;
      if (Date.now() > deadline) throw new Error(`still open: ${entry?.state}`);
      await sleep(200);
    }
  };

  it("sponsors a session UserOp: the stub fails validation softly, the data validates on the deployed paymaster, and the deposit's charge is settled", async () => {
    const op: PaymasterUserOperation = {
      sender: root.address,
      nonce: await nonceOf(root.address, laneOf(keyHash)),
      callData: encodeUserOpCallData([approve(1n)]),
      callGasLimit: 300_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      ...(await fees()),
    };

    // Stub: shaped like the real data, a signature that recovers to no sponsor key.
    const stub = await call<PmResult>(
      PM_GET_PAYMASTER_STUB_DATA_METHOD,
      await params(PM_GET_PAYMASTER_STUB_DATA_METHOD, session, op, keyHash),
    );
    expect(stub.error).toBeUndefined();
    const stubData = stub.result as PmResult;
    expect(stubData).toMatchObject({ paymaster: PM, isFinal: false });
    expect(stubData.paymasterData.endsWith(STUB_SIGNATURE.slice(2))).toBe(true);
    // Gas estimation runs the paymaster's validation: the stub returns SIG_VALIDATION_FAILED, it
    // does not revert (ECDSA.recover of a malformed signature would, docs/DEFERRED_ISSUES.md).
    const [, stubValidation] = (
      await client.simulateContract({
        account: EP,
        address: PM,
        abi: paymasterAbi,
        functionName: "validatePaymasterUserOp",
        args: [toPackedUserOperation(withPaymaster(op, stubData)), `0x${"00".repeat(32)}`, 0n],
      })
    ).result;
    expect(stubValidation & 1n).toBe(1n);
    expect(store.entries()).toHaveLength(0);

    const dataParams = await params(PM_GET_PAYMASTER_DATA_METHOD, session, op, keyHash);
    const data = await call<PmResult>(PM_GET_PAYMASTER_DATA_METHOD, dataParams);
    expect(data.error).toBeUndefined();
    const result = data.result as PmResult;
    const sponsoredOp = withPaymaster(op, result);
    const validUntil = Number(BigInt(`0x${result.paymasterData.slice(2, 66)}`));

    // The sponsor's hash is the deployed paymaster's getHash, and its signature validates there.
    expect(
      await client.readContract({
        address: PM,
        abi: paymasterAbi,
        functionName: "getHash",
        args: [toPackedUserOperation(sponsoredOp), validUntil, 0],
      }),
    ).toBe(paymasterHash(op, { chainId: 5003, paymaster: PM, entryPoint: EP }, validUntil, 0));
    await expectValidationFits("session", sponsoredOp);

    // A retry returns the same result and reserves nothing more.
    const retry = await call<PmResult>(PM_GET_PAYMASTER_DATA_METHOD, dataParams);
    expect(retry.result).toEqual(result);
    expect(store.entries()).toHaveLength(1);

    const before = await deposit();
    const event = await handleOps({
      ...sponsoredOp,
      signature: encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes" }, { type: "bytes" }],
        [keyHash, await accountSignature(session, sponsoredOp), "0x"],
      ),
    });
    expect(event.args).toMatchObject({ success: true, paymaster: PM, sender: root.address });
    expect(before - (await deposit())).toBe(event.args.actualGasCost);

    const entry = await settled(result.paymasterData);
    expect(entry.state).toBe("settled");
    expect(entry.paymaster?.userOpHash).toBe(event.args.userOpHash);
    expect(entry.charged).toEqual({ gas: event.args.actualGasUsed, fee: event.args.actualGasCost });
    expect(entry.reserved).toEqual({ gas: 0n, fee: 0n });
    expect(store.usage(dayOf(nowSeconds()), root.address).account.business).toEqual(entry.charged);
  }, 120_000);

  it("sponsors the root's init UserOp with eip7702Auth and the 2-byte 0x7702 initCode", async () => {
    const authorization = await fresh.signAuthorization({
      address: book.caliburEntry,
      chainId: 5003,
      nonce: await client.getTransactionCount({ address: fresh.address }),
    });
    const op: PaymasterUserOperation = {
      sender: fresh.address,
      nonce: await nonceOf(fresh.address, 0n),
      factory: "0x7702",
      callData: encodeUserOpCallData([
        {
          to: fresh.address,
          value: 0n,
          data: encodeFunctionData({
            abi: caliburAbi,
            functionName: "approveNative",
            args: [ERC20ETH, 0n],
          }),
        },
      ]),
      callGasLimit: 200_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      ...(await fees()),
      authorization,
    };
    const data = await call<PmResult>(
      PM_GET_PAYMASTER_DATA_METHOD,
      await params(PM_GET_PAYMASTER_DATA_METHOD, fresh, op, ROOT_KEY_HASH),
    );
    expect(data.error).toBeUndefined();
    const result = data.result as PmResult;
    const sponsoredOp = withPaymaster(op, result);
    expect(toPackedUserOperation(sponsoredOp).initCode).toBe("0x7702");
    const validUntil = Number(BigInt(`0x${result.paymasterData.slice(2, 66)}`));
    expect(
      await client.readContract({
        address: PM,
        abi: paymasterAbi,
        functionName: "getHash",
        args: [toPackedUserOperation(sponsoredOp), validUntil, 0],
      }),
    ).toBe(paymasterHash(op, { chainId: 5003, paymaster: PM, entryPoint: EP }, validUntil, 0));

    // Validation reads the sender's delegation, which the bundle's authorization sets first.
    await client.request({
      method: "anvil_setCode" as never,
      params: [fresh.address, delegationDesignator(book.caliburEntry)] as never,
    });
    await expectValidationFits("root init", sponsoredOp);
    await client.request({
      method: "anvil_setCode" as never,
      params: [fresh.address, "0x"] as never,
    });

    // The root's signature is raw over the userOpHash (no keyHash wrapper), sent in a type-4 bundle.
    const before = await deposit();
    const event = await handleOps(
      { ...sponsoredOp, signature: await accountSignature(fresh, sponsoredOp) },
      authorization,
    );
    expect(event.args).toMatchObject({ success: true, paymaster: PM, sender: fresh.address });
    expect(before - (await deposit())).toBe(event.args.actualGasCost);
    expect(await client.getCode({ address: fresh.address })).toBe(
      delegationDesignator(book.caliburEntry),
    );

    const entry = await settled(result.paymasterData);
    expect(entry).toMatchObject({ state: "settled", budgetClass: "management" });
    expect(entry.paymaster?.userOpHash).toBe(event.args.userOpHash);
    expect(entry.charged.fee).toBe(event.args.actualGasCost);
  }, 120_000);

  // Last: it moves the fork's clock forward.
  it("releases a sponsorship never included, only once the chain is past its validUntil", async () => {
    const { timestamp } = await client.getBlock();
    const op: PaymasterUserOperation = {
      sender: root.address,
      nonce: await nonceOf(root.address, laneOf(keyHash)),
      callData: encodeUserOpCallData([approve(2n)]),
      callGasLimit: 300_000n,
      verificationGasLimit: 300_000n,
      preVerificationGas: 60_000n,
      ...(await fees()),
    };
    const validUntil = Math.max(nowSeconds(), Number(timestamp)) + 30;
    const day = dayOf(nowSeconds());
    const usage = () => store.usage(day, root.address).account.business;
    const before = usage();
    const data = await call<PmResult>(
      PM_GET_PAYMASTER_DATA_METHOD,
      await params(PM_GET_PAYMASTER_DATA_METHOD, session, op, keyHash, validUntil),
    );
    const result = data.result as PmResult;
    const open = store
      .entries()
      .find((e) => e.paymaster?.result.paymasterData === result.paymasterData) as LedgerEntry;
    expect(open.state).toBe("submitted");
    expect(usage()).toEqual({
      gas: before.gas + open.reserved.gas,
      fee: before.fee + open.reserved.fee,
    });

    // Several reconciliation passes before validUntil: still reserved.
    await sleep(1_000);
    expect(store.entry(open.digest)?.state).toBe("submitted");

    await client.request({ method: "evm_increaseTime" as never, params: [60] as never });
    await client.request({ method: "evm_mine" as never });
    const entry = await settled(result.paymasterData);
    expect(entry.state).toBe("released");
    expect(entry.charged).toEqual({ gas: 0n, fee: 0n });
    // Released only after searching up to a block the EntryPoint can no longer include it in.
    const last = await client.getBlock({ blockNumber: BigInt(entry.paymaster?.scannedTo ?? 0) });
    expect(last.timestamp).toBeGreaterThan(BigInt(validUntil));
    expect(usage()).toEqual(before);
  }, 120_000);
});
