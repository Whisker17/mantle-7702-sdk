import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Call,
  caliburAbi,
  delegationDesignator,
  encodeUserOpCallData,
  laneOf,
  mantleSepolia,
  type PaymasterDataResult,
  type PaymasterMethod,
  type PaymasterUserOperation,
  PM_GET_PAYMASTER_DATA_METHOD,
  PM_GET_PAYMASTER_STUB_DATA_METHOD,
  PrivateKeySigner,
  paymasterRequestParams,
  ROOT_KEY_HASH,
  SPONSOR_REJECTED_RPC_CODE,
  SponsorRejectCode,
  secp256k1KeyHash,
  signPaymasterRequest,
} from "@mantle-aa/sdk";
import {
  type Address,
  createClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  type Hex,
  keccak256,
  pad,
  parseAbiItem,
  parseEther,
  parseGwei,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SponsorRejection } from "../src/auth.js";
import type { SponsorConfig } from "../src/config.js";
import { userOpFeeBound } from "../src/fees.js";
import {
  LOG_BLOCK_RANGE,
  PAYMASTER_POST_OP_GAS,
  PAYMASTER_VERIFICATION_GAS,
  type PaymasterIssuer,
  PaymasterLedger,
  STUB_SIGNATURE,
  sponsorUserOp,
} from "../src/paymaster.js";
import { createSponsorServer, type SponsorContext } from "../src/server.js";
import { dayOf, SponsorStore } from "../src/store.js";
import { book, nowSeconds, RELAYER_ADDRESS, testConfig } from "./fixtures.js";

const root = new PrivateKeySigner(generatePrivateKey());
const session = new PrivateKeySigner(generatePrivateKey());
const KEY_HASH = secp256k1KeyHash(session.address);
const OTHER_KEY_HASH = secp256k1KeyHash(new PrivateKeySigner(generatePrivateKey()).address);
const noop: Call = { to: root.address, value: 0n, data: "0x" };

const userOp = (over: Partial<PaymasterUserOperation> = {}): PaymasterUserOperation => ({
  sender: root.address,
  nonce: 0n,
  callData: encodeUserOpCallData([noop]),
  callGasLimit: 100_000n,
  verificationGasLimit: 200_000n,
  preVerificationGas: 50_000n,
  maxFeePerGas: parseGwei("100"),
  maxPriorityFeePerGas: parseGwei("1"),
  ...over,
});

interface RequestOptions {
  method?: PaymasterMethod;
  signer?: PrivateKeySigner;
  keyHash?: Hex;
  op?: PaymasterUserOperation;
  entryPoint?: Address;
  chainId?: number;
  sponsor?: Address;
  now?: number;
  validUntil?: number;
}

/** Params of a paymaster request signed the way the SDK client signs one (root by default). */
async function request(o: RequestOptions = {}) {
  const now = o.now ?? nowSeconds();
  return paymasterRequestParams(
    await signPaymasterRequest(o.signer ?? root, o.method ?? PM_GET_PAYMASTER_DATA_METHOD, {
      userOp: o.op ?? userOp(),
      entryPoint: o.entryPoint ?? book.entryPoint,
      chainId: o.chainId ?? 5003,
      auth: {
        sponsor: o.sponsor ?? RELAYER_ADDRESS,
        keyHash: o.keyHash ?? ROOT_KEY_HASH,
        validAfter: now - 5,
        validUntil: o.validUntil ?? now + 60,
      },
    }),
  );
}
const sessionRequest = (o: RequestOptions = {}) =>
  request({
    signer: session,
    keyHash: KEY_HASH,
    op: userOp({ nonce: laneOf(KEY_HASH) << 64n }),
    ...o,
  });

const userOperationEvent = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

/**
 * A chain just big enough for the paymaster path: the account delegated to CaliburEntry, a passing
 * simulation, the paymaster's `verifyingSigner`, a head block whose number and time the test moves,
 * and `UserOperationEvent` logs, with Mantle Sepolia's `eth_getLogs` span limit.
 */
class FakeChain {
  head = { number: 1_000n, timestamp: BigInt(nowSeconds()) };
  verifyingSigner: Address = "0x0000000000000000000000000000000000000000";
  events = new Map<Hex, { block: bigint; success: boolean; cost: bigint; used: bigint }>();
  /** Every `eth_getLogs` span requested. */
  ranges: [bigint, bigint][] = [];
  failLogs = false;
  /** Holds the next `eth_getLogs` (its span already fixed) until it resolves. */
  logsGate: Promise<void> | undefined;
  simulationReverts = false;
  readonly client = createClient({
    chain: mantleSepolia,
    transport: custom({ request: ({ method, params }) => this.#request(method, params as never) }),
  });

  async #request(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return "0x138b";
      case "eth_getCode":
        return delegationDesignator(book.caliburEntry);
      case "eth_estimateGas":
        if (this.simulationReverts) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        }
        return toHex(60_000n);
      case "eth_call":
        return pad(this.verifyingSigner);
      case "eth_blockNumber":
        return toHex(this.head.number);
      case "eth_getBlockByNumber":
        return {
          number: toHex(this.head.number),
          timestamp: toHex(this.head.timestamp),
          hash: keccak256(toHex(this.head.number)),
          baseFeePerGas: toHex(parseGwei("50")),
        };
      case "eth_getLogs": {
        const gate = this.logsGate;
        this.logsGate = undefined;
        await gate;
        if (this.failLogs) throw Object.assign(new Error("upstream unavailable"), { code: -32000 });
        const [{ fromBlock, toBlock, topics }] = params as [
          { fromBlock: Hex; toBlock: Hex; topics: Hex[] },
        ];
        const [from, to] = [BigInt(fromBlock), BigInt(toBlock)];
        if (to - from > 10_000n) {
          throw Object.assign(new Error("block range greater than 10000 max"), { code: -32602 });
        }
        if (to > this.head.number) {
          throw Object.assign(new Error("requested block is above the latest"), { code: -32000 });
        }
        this.ranges.push([from, to]);
        const userOpHash = topics[1] as Hex;
        const e = this.events.get(userOpHash);
        if (!e || e.block < from || e.block > to) return [];
        return [
          {
            address: book.entryPoint,
            topics: encodeEventTopics({
              abi: [userOperationEvent],
              eventName: "UserOperationEvent",
              args: { userOpHash, sender: root.address, paymaster: book.verifyingPaymaster },
            }),
            data: encodeAbiParameters(
              [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
              [0n, e.success, e.cost, e.used],
            ),
            blockNumber: toHex(e.block),
            blockHash: keccak256(toHex(e.block)),
            transactionHash: keccak256(userOpHash),
            transactionIndex: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ];
      }
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  }

  /** Mines `blocks` blocks, `seconds` apart in total. */
  advance(blocks: bigint, seconds: number): void {
    this.head = {
      number: this.head.number + blocks,
      timestamp: this.head.timestamp + BigInt(seconds),
    };
  }
}

const config: SponsorConfig = testConfig({
  allowlist: [root.address],
  maxFeePerRequest: parseEther("1"),
});

describe("paymaster request checks", () => {
  /** No RPC answers: every rejection below happens before the sponsor reads the chain. */
  const offline = createClient({
    chain: mantleSepolia,
    transport: custom({
      request: async ({ method }) => {
        throw new Error(`unexpected RPC ${method}`);
      },
    }),
  });
  const ctx: SponsorContext = { config, client: offline, store: new SponsorStore(":memory:") };
  const reason = async (
    params: unknown,
    method: PaymasterMethod = PM_GET_PAYMASTER_DATA_METHOD,
  ) => {
    const error = await sponsorUserOp(ctx, method, params).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SponsorRejection);
    return (error as SponsorRejection).reason;
  };
  const authorization = (signer = root, address = book.caliburEntry) =>
    signer.signAuthorization({ address, chainId: 5003, nonce: 0 });

  it.each([PM_GET_PAYMASTER_DATA_METHOD, PM_GET_PAYMASTER_STUB_DATA_METHOD] as const)(
    "rejects a wrong lane with a structured reason (%s)",
    async (method) => {
      // A session on another key's lane, a root on a session's lane, a session on the root's lane.
      expect(
        await reason(
          await sessionRequest({ method, op: userOp({ nonce: laneOf(OTHER_KEY_HASH) << 64n }) }),
          method,
        ),
      ).toBe(SponsorRejectCode.WRONG_LANE);
      expect(
        await reason(
          await request({ method, op: userOp({ nonce: laneOf(KEY_HASH) << 64n }) }),
          method,
        ),
      ).toBe(SponsorRejectCode.WRONG_LANE);
      expect(
        await reason(await sessionRequest({ method, op: userOp({ nonce: 0n }) }), method),
      ).toBe(SponsorRejectCode.ROOT_LANE_MISUSE);
    },
  );

  it("answers a wrong lane over JSON-RPC as a sponsor rejection naming the reason", async () => {
    const server = createSponsorServer(ctx);
    const url = await server.listen();
    try {
      const params = await sessionRequest({
        op: userOp({ nonce: (laneOf(OTHER_KEY_HASH) << 64n) | 3n }),
      });
      const res = await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: PM_GET_PAYMASTER_DATA_METHOD,
          params,
        }),
      });
      const body = (await res.json()) as { id: number; error: { code: number; data: unknown } };
      expect(body.id).toBe(7);
      expect(body.error.code).toBe(SPONSOR_REJECTED_RPC_CODE);
      expect(body.error.data).toEqual({
        reason: SponsorRejectCode.WRONG_LANE,
        detail: `lane ${laneOf(OTHER_KEY_HASH)} is not ${KEY_HASH}'s lane ${laneOf(KEY_HASH)}`,
      });
    } finally {
      await server.close();
    }
  });

  it("allows eip7702Auth and the 2-byte 0x7702 initCode only together, and only on the root's init", async () => {
    const auth = await authorization();
    const withAuth = (over: Partial<PaymasterUserOperation>) =>
      userOp({ authorization: auth, ...over });
    const cases: [string, Promise<unknown>, SponsorRejectCode][] = [
      [
        "session with eip7702Auth",
        sessionRequest({
          op: userOp({ nonce: laneOf(KEY_HASH) << 64n, factory: "0x7702", authorization: auth }),
        }),
        SponsorRejectCode.AUTHORIZATION_INVALID,
      ],
      [
        "session with initCode 0x7702",
        sessionRequest({ op: userOp({ nonce: laneOf(KEY_HASH) << 64n, factory: "0x7702" }) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "root with eip7702Auth, no initCode",
        request({ op: withAuth({}) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "root with the 20-byte marker",
        request({ op: withAuth({ factory: "0x7702000000000000000000000000000000000000" }) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "root with init data after 0x7702",
        request({ op: withAuth({ factory: "0x7702", factoryData: "0x01" }) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "root with 0x7702, no eip7702Auth",
        request({ op: userOp({ factory: "0x7702" }) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "root with a factory",
        request({ op: userOp({ factory: book.caliburEntry, factoryData: "0x" }) }),
        SponsorRejectCode.INIT_CODE_INVALID,
      ],
      [
        "an authorization the sender did not sign",
        request({
          op: withAuth({ factory: "0x7702", authorization: await authorization(session) }),
        }),
        SponsorRejectCode.AUTHORIZATION_INVALID,
      ],
      [
        "an authorization to another delegate",
        request({
          op: withAuth({
            factory: "0x7702",
            authorization: await authorization(root, book.mockUsd),
          }),
        }),
        SponsorRejectCode.AUTHORIZATION_INVALID,
      ],
    ];
    for (const [label, params, code] of cases) expect(await reason(await params), label).toBe(code);
  });

  it("rejects the envelope: chain, EntryPoint, sponsor, validity, calldata, signature, shape", async () => {
    const now = nowSeconds();
    const executeData = encodeFunctionData({
      abi: caliburAbi,
      functionName: "approveNative",
      args: [root.address, 0n],
    });
    const cases: [string, unknown, SponsorRejectCode][] = [
      ["another chain", await request({ chainId: 5000 }), SponsorRejectCode.WRONG_CHAIN],
      [
        "another EntryPoint",
        await request({ entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" }),
        SponsorRejectCode.WRONG_DOMAIN,
      ],
      ["another sponsor", await request({ sponsor: root.address }), SponsorRejectCode.WRONG_DOMAIN],
      ["an expired request", await request({ now: now - 600 }), SponsorRejectCode.REQUEST_EXPIRED],
      [
        "a too-long validity",
        await request({ validUntil: now + 3600 }),
        SponsorRejectCode.REQUEST_EXPIRED,
      ],
      [
        "calldata that is not executeUserOp",
        await request({ op: userOp({ callData: executeData }) }),
        SponsorRejectCode.INVALID_PARAMS,
      ],
      [
        "a request the session did not sign",
        await sessionRequest({ signer: root }),
        SponsorRejectCode.BAD_REQUEST_SIGNATURE,
      ],
      [
        "a root request the sender did not sign",
        await request({ signer: session }),
        SponsorRejectCode.BAD_REQUEST_SIGNATURE,
      ],
      [
        "params that are not [userOp, entryPoint, chainId, context]",
        [{}],
        SponsorRejectCode.INVALID_PARAMS,
      ],
    ];
    for (const [label, params, code] of cases) expect(await reason(params), label).toBe(code);
  });
});

describe("the 4337 fee bound", () => {
  it("is EntryPoint v0.8's required prefund with the paymaster's gas limits", () => {
    const op = userOp();
    const gas =
      op.verificationGasLimit +
      op.callGasLimit +
      PAYMASTER_VERIFICATION_GAS +
      PAYMASTER_POST_OP_GAS +
      op.preVerificationGas;
    expect(
      userOpFeeBound({
        ...op,
        paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
        paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
      }),
    ).toEqual({ gas, maxFee: gas * op.maxFeePerGas });
  });
});

describe("paymaster sponsorship and its reservation", () => {
  let chain: FakeChain;
  let store: SponsorStore;
  let ledger: PaymasterLedger;
  let clock: number;
  let day: number;
  let ctx: SponsorContext & { paymaster: PaymasterIssuer };
  const signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey);

  beforeEach(() => {
    chain = new FakeChain();
    chain.verifyingSigner = signer.address;
    store = new SponsorStore(":memory:");
    ledger = new PaymasterLedger({
      config,
      client: chain.client,
      store,
      signer,
      pollIntervalMs: 60_000,
    });
    clock = nowSeconds();
    day = dayOf(clock);
    ctx = { config, client: chain.client, store, now: () => clock, paymaster: ledger };
  });
  afterEach(async () => {
    await ledger.close();
    store.close();
  });

  const sponsor = (params: unknown) =>
    sponsorUserOp(ctx, PM_GET_PAYMASTER_DATA_METHOD, params) as Promise<PaymasterDataResult>;
  const rejection = async (method: PaymasterMethod, params: unknown) => {
    const error = await sponsorUserOp(ctx, method, params).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SponsorRejection);
    return (error as SponsorRejection).reason;
  };
  const usage = () => store.usage(day, root.address).account.business;
  const only = () => {
    const entries = store.entries();
    expect(entries).toHaveLength(1);
    return entries[0] as (typeof entries)[0];
  };
  const reserved = () => {
    const { gas, maxFee } = userOpFeeBound({
      ...userOp(),
      paymasterVerificationGasLimit: PAYMASTER_VERIFICATION_GAS,
      paymasterPostOpGasLimit: PAYMASTER_POST_OP_GAS,
    });
    return { gas, fee: maxFee };
  };

  it("answers the stub with a placeholder signature and reserves nothing", async () => {
    const stub = await sponsorUserOp(
      ctx,
      PM_GET_PAYMASTER_STUB_DATA_METHOD,
      await request({ method: PM_GET_PAYMASTER_STUB_DATA_METHOD, now: clock }),
    );
    expect(stub).toMatchObject({
      paymaster: book.verifyingPaymaster,
      paymasterVerificationGasLimit: toHex(PAYMASTER_VERIFICATION_GAS),
      paymasterPostOpGasLimit: "0x0",
      isFinal: false,
    });
    expect(stub.paymasterData).toBe(
      `${encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [clock + 60, 0])}${STUB_SIGNATURE.slice(2)}`,
    );
    expect(store.entries()).toHaveLength(0);
    expect(usage()).toEqual({ gas: 0n, fee: 0n });
  });

  it("refuses without a paymaster signer, after every check passed", async () => {
    const { paymaster: _, ...noSigner } = ctx;
    for (const method of [
      PM_GET_PAYMASTER_STUB_DATA_METHOD,
      PM_GET_PAYMASTER_DATA_METHOD,
    ] as const) {
      const error = await sponsorUserOp(
        noSigner,
        method,
        await request({ method, now: clock }),
      ).catch((e) => e);
      expect((error as SponsorRejection).reason).toBe(SponsorRejectCode.SUBMISSION_UNAVAILABLE);
    }
  });

  it("refuses a UserOp its own simulation reverts, or whose fee bound breaks the cap", async () => {
    chain.simulationReverts = true;
    expect(await rejection(PM_GET_PAYMASTER_DATA_METHOD, await request({ now: clock }))).toBe(
      SponsorRejectCode.SIMULATION_FAILED,
    );
    chain.simulationReverts = false;
    const costly = await request({ now: clock, op: userOp({ maxFeePerGas: parseGwei("5000") }) });
    expect(await rejection(PM_GET_PAYMASTER_DATA_METHOD, costly)).toBe(
      SponsorRejectCode.REQUEST_FEE_CAP,
    );
    expect(store.entries()).toHaveLength(0);
  });

  it("retries neither extend validity nor add reservations (same request or same paymaster hash → same result)", async () => {
    const params = await request({ now: clock });
    const first = await sponsor(params);
    const entry = only();
    expect(entry).toMatchObject({
      state: "submitted",
      budgetClass: "business",
      reserved: reserved(),
    });
    expect(usage()).toEqual(reserved());
    const validUntil = clock + 60;
    expect(first.paymasterData.slice(0, 130)).toBe(
      encodeAbiParameters([{ type: "uint48" }, { type: "uint48" }], [validUntil, 0]),
    );

    // The same request again, also after its validity: the same result, nothing more reserved.
    expect(await sponsor(params)).toEqual(first);
    clock += 3_600;
    expect(await sponsor(params)).toEqual(first);
    expect(only()).toEqual(entry);
    expect(usage()).toEqual(reserved());

    // Asking again with a fresh window cannot extend it while the reservation is open, nor can
    // another UserOp take a second reservation for the account; the stub says so too.
    expect(await rejection(PM_GET_PAYMASTER_DATA_METHOD, await request({ now: clock }))).toBe(
      SponsorRejectCode.SPONSOR_BUSY,
    );
    const other = { now: clock, op: userOp({ nonce: 1n }) };
    expect(await rejection(PM_GET_PAYMASTER_DATA_METHOD, await request(other))).toBe(
      SponsorRejectCode.SPONSOR_BUSY,
    );
    expect(
      await rejection(
        PM_GET_PAYMASTER_STUB_DATA_METHOD,
        await request({ ...other, method: PM_GET_PAYMASTER_STUB_DATA_METHOD }),
      ),
    ).toBe(SponsorRejectCode.SPONSOR_BUSY);
    expect(store.entries()).toHaveLength(1);
  });

  it("a signature that loses the race to the same paymaster hash returns the recorded result", async () => {
    const params = await request({ now: clock });
    const [a, b] = await Promise.all([sponsor(params), sponsor(params)]);
    expect(a).toEqual(b);
    expect(only().reserved).toEqual(reserved());
    expect(usage()).toEqual(reserved());
  });

  it.each([true, false])(
    "settles an included UserOp with its actualGasCost (success: %s)",
    async (success) => {
      const result = await sponsor(await request({ now: clock }));
      const { paymaster } = only();
      chain.events.set(paymaster?.userOpHash as Hex, {
        block: chain.head.number + 2n,
        success,
        cost: 123_456_789n,
        used: 98_765n,
      });
      chain.advance(1n, 2);
      await ledger.reconcile();
      expect(only().state).toBe("submitted");
      chain.advance(2n, 4);
      await ledger.reconcile();
      const entry = only();
      expect(entry).toMatchObject({
        state: "settled",
        reserved: { gas: 0n, fee: 0n },
        charged: { gas: 98_765n, fee: 123_456_789n },
      });
      expect(entry.paymaster).toMatchObject({
        result,
        included: { success, actualGasCost: "123456789", actualGasUsed: "98765" },
      });
      expect(usage()).toEqual({ gas: 98_765n, fee: 123_456_789n });
      // Settled, the account may be sponsored again; the old request still returns its result.
      expect(await sponsor(await request({ now: clock, op: userOp({ nonce: 1n }) }))).toBeDefined();
      expect(ledger.find(entry.digest)).toEqual(result);
    },
  );

  /** Sponsors a first UserOp and puts its UserOperationEvent in the next block. */
  const sponsorIncluded = async () => {
    await sponsor(await request({ now: clock }));
    const event = { block: chain.head.number + 1n, success: true, cost: 4_321n, used: 1_234n };
    chain.events.set(only().paymaster?.userOpHash as Hex, event);
    chain.advance(2n, 4);
    return only().digest;
  };
  const next = (method: PaymasterMethod) =>
    request({ method, now: clock, op: userOp({ nonce: 1n }) });

  it.each([PM_GET_PAYMASTER_DATA_METHOD, PM_GET_PAYMASTER_STUB_DATA_METHOD] as const)(
    "accepts the next request right after the previous UserOp's inclusion, before the loop runs, settling it with its actualGasCost (%s)",
    async (method) => {
      const first = await sponsorIncluded();
      // The loop polls every minute: only the request itself can have settled the first entry.
      const result = await sponsorUserOp(ctx, method, await next(method));
      expect(result).toMatchObject({ paymaster: book.verifyingPaymaster });
      expect(store.entry(first)).toMatchObject({
        state: "settled",
        reserved: { gas: 0n, fee: 0n },
        charged: { gas: 1_234n, fee: 4_321n },
        paymaster: { included: { success: true, actualGasCost: "4321", actualGasUsed: "1234" } },
      });
      const open = store.entries(["submitted"]);
      expect(open).toHaveLength(method === PM_GET_PAYMASTER_DATA_METHOD ? 1 : 0);
      expect(usage()).toEqual(
        method === PM_GET_PAYMASTER_DATA_METHOD
          ? { gas: 1_234n + reserved().gas, fee: 4_321n + reserved().fee }
          : { gas: 1_234n, fee: 4_321n },
      );
    },
  );

  it.each([PM_GET_PAYMASTER_DATA_METHOD, PM_GET_PAYMASTER_STUB_DATA_METHOD] as const)(
    "still refuses SPONSOR_BUSY while the previous sponsorship is unincluded and valid, or its logs cannot be read (%s)",
    async (method) => {
      await sponsor(await request({ now: clock }));
      const { digest, paymaster } = only();
      chain.advance(5n, 10);
      expect(await rejection(method, await next(method))).toBe(SponsorRejectCode.SPONSOR_BUSY);
      // The request searched the chain up to its head and found nothing.
      expect(store.entry(digest)?.paymaster?.scannedTo).toBe(Number(chain.head.number));

      chain.events.set(paymaster?.userOpHash as Hex, {
        block: chain.head.number + 1n,
        success: true,
        cost: 1n,
        used: 1n,
      });
      chain.advance(1n, 2);
      chain.failLogs = true;
      expect(await rejection(method, await next(method))).toBe(SponsorRejectCode.SPONSOR_BUSY);
      expect(only()).toMatchObject({ state: "submitted", reserved: reserved() });
      expect(usage()).toEqual(reserved());
    },
  );

  it("a request racing the loop settles the previous sponsorship exactly once", async () => {
    const first = await sponsorIncluded();
    const method = PM_GET_PAYMASTER_DATA_METHOD;
    await Promise.all([ledger.reconcile(), sponsor(await next(method)), ledger.reconcile()]);
    expect(store.entry(first)).toMatchObject({
      state: "settled",
      charged: { gas: 1_234n, fee: 4_321n },
    });
    expect(store.entries(["submitted"])).toHaveLength(1);
    expect(usage()).toEqual({ gas: 1_234n + reserved().gas, fee: 4_321n + reserved().fee });
  });

  it("a pass that searched too few blocks never rewrites an entry another pass settled", async () => {
    await sponsor(await request({ now: clock }));
    const { digest, paymaster } = only();
    chain.advance(1n, 2);
    let open: () => void = () => undefined;
    chain.logsGate = new Promise((resolve) => {
      open = resolve;
    });
    // The slow pass's span ends before the UserOp's block; a faster pass then finds and settles it.
    const slow = ledger.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 10));
    chain.events.set(paymaster?.userOpHash as Hex, {
      block: chain.head.number + 1n,
      success: true,
      cost: 9n,
      used: 8n,
    });
    chain.advance(1n, 2);
    await ledger.reconcile();
    const settled = store.entry(digest);
    expect(settled?.state).toBe("settled");
    open();
    await slow;
    expect(store.entry(digest)).toEqual(settled);
    expect(usage()).toEqual({ gas: 8n, fee: 9n });
  });

  it("releases a never-included sponsorship only once a block past validUntil has been searched", async () => {
    const validUntil = clock + 60;
    await sponsor(await request({ now: clock }));
    const signedAt = chain.head.number;

    // The local clock is past validUntil, the chain is not: the reservation stays.
    clock += 3_600;
    chain.advance(10n, 30);
    await ledger.reconcile();
    expect(only().state).toBe("submitted");

    // The chain is past validUntil, but its logs cannot be read: the reservation stays.
    chain.advance(12_000n, 24_000);
    expect(chain.head.timestamp).toBeGreaterThan(BigInt(validUntil));
    chain.failLogs = true;
    await expect(ledger.reconcile()).rejects.toThrow();
    expect(only().state).toBe("submitted");
    expect(usage()).toEqual(reserved());

    chain.failLogs = false;
    chain.ranges = [];
    await ledger.reconcile();
    const entry = only();
    expect(entry).toMatchObject({
      state: "released",
      reserved: { gas: 0n, fee: 0n },
      charged: { gas: 0n, fee: 0n },
    });
    expect(entry.paymaster?.scannedTo).toBe(Number(chain.head.number));
    expect(usage()).toEqual({ gas: 0n, fee: 0n });
    // Every block after the first poll was searched once, in spans the public RPC accepts.
    expect(chain.ranges[0]?.[0]).toBe(signedAt + 11n);
    for (const [from, to] of chain.ranges)
      expect(to - from + 1n).toBeLessThanOrEqual(LOG_BLOCK_RANGE);
    for (let i = 1; i < chain.ranges.length; i++) {
      expect(chain.ranges[i]?.[0]).toBe((chain.ranges[i - 1]?.[1] as bigint) + 1n);
    }
    expect(chain.ranges.at(-1)?.[1]).toBe(chain.head.number);
  });

  it("start refuses a key that is not the paymaster's signer, and reconciles what was left open", async () => {
    await sponsor(await request({ now: clock }));
    chain.events.set(only().paymaster?.userOpHash as Hex, {
      block: chain.head.number + 1n,
      success: true,
      cost: 7n,
      used: 5n,
    });
    chain.advance(3n, 6);

    const stranger = privateKeyToAccount(generatePrivateKey());
    const wrong = new PaymasterLedger({ config, client: chain.client, store, signer: stranger });
    await expect(wrong.start()).rejects.toThrow(/verifyingSigner/);
    expect(only().state).toBe("submitted");

    const restarted = new PaymasterLedger({
      config,
      client: chain.client,
      store,
      signer,
      pollIntervalMs: 60_000,
    });
    await restarted.start();
    await restarted.close();
    expect(only()).toMatchObject({ state: "settled", charged: { gas: 5n, fee: 7n } });
  });
});

describe("the ledger database", () => {
  it("gains the paymaster column when opened from before the paymaster methods", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sponsor-store-")), "old.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE ledger (
      digest TEXT PRIMARY KEY, batch_digest TEXT NOT NULL UNIQUE, account TEXT NOT NULL,
      class TEXT NOT NULL, day INTEGER NOT NULL, state TEXT NOT NULL, nonce INTEGER,
      reserved_gas TEXT NOT NULL, reserved_fee TEXT NOT NULL,
      charged_gas TEXT NOT NULL DEFAULT '0', charged_fee TEXT NOT NULL DEFAULT '0',
      result TEXT, error TEXT)`);
    old.close();
    const store = new SponsorStore(path);
    try {
      const digest = keccak256("0x01");
      store.insertEntry({
        digest,
        batchDigest: keccak256("0x02"),
        account: root.address,
        budgetClass: "business",
        day: 1,
        state: "submitted",
        reserved: { gas: 1n, fee: 2n },
      });
      expect(store.entry(digest)?.paymaster).toBeNull();
    } finally {
      store.close();
    }
  });
});
