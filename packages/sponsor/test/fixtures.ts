import {
  type Call,
  laneOf,
  loadDeployments,
  mantleSepolia,
  type Signer,
  signBatchedCall,
  signRelayRequest,
} from "@mantle-aa/sdk";
import {
  type Address,
  type Client,
  createClient,
  custom,
  type Hex,
  parseEther,
  type SignedAuthorization,
} from "viem";
import type { SponsorConfig } from "../src/config.js";

export const book = loadDeployments();
export const RELAYER_ADDRESS: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const testConfig = (over: Partial<SponsorConfig["policy"]> = {}): SponsorConfig => ({
  chainId: 5003,
  rpcUrl: "http://127.0.0.1:1",
  listen: { host: "127.0.0.1", port: 0 },
  database: ":memory:",
  relayer: RELAYER_ADDRESS,
  addresses: book,
  maxRequestValiditySeconds: 300,
  policy: {
    allowlist: [],
    accountDailyGas: 5_000_000n,
    maxFeePerRequest: parseEther("0.05"),
    dailyBudget: parseEther("5"),
    managementReserve: parseEther("1"),
    ...over,
  },
});

/** A viem client whose RPC answers only the given methods; anything else fails the test. */
export const stubClient = (handlers: Record<string, (params: unknown) => unknown>): Client =>
  createClient({
    chain: mantleSepolia,
    transport: custom({
      async request({ method, params }) {
        const handler = handlers[method];
        if (!handler) throw new Error(`unexpected RPC ${method}`);
        return handler(params);
      },
    }),
  });

/** An undelegated account (empty code, nonce 0): batch domains are computed offline. */
export const undelegatedClient = () =>
  stubClient({ eth_getCode: () => "0x", eth_getTransactionCount: () => "0x0" });

export interface RequestOptions {
  client: Client;
  account: Address;
  /** Signs the batch. */
  signer: Signer;
  keyHash: Hex;
  calls?: readonly Call[];
  nonce?: bigint;
  executor?: Address;
  /** Signs the request digest; defaults to `signer`. */
  requestSigner?: Signer;
  authorization?: SignedAuthorization;
  auth?: Partial<{
    chainId: number;
    sponsor: Address;
    entry: Address;
    validAfter: number;
    validUntil: number;
  }>;
  now?: number;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A `sponsor_relay` request signed the way the SDK client signs one. */
export async function relayRequest(o: RequestOptions) {
  const now = o.now ?? nowSeconds();
  const data = await signBatchedCall(o.client, {
    account: o.account,
    implementation: book.caliburEntry,
    chainId: 5003,
    signer: o.signer,
    keyHash: o.keyHash,
    calls: o.calls ?? [{ to: o.account, value: 0n, data: "0x" }],
    nonce: o.nonce ?? laneOf(o.keyHash) << 64n,
    executor: o.executor ?? RELAYER_ADDRESS,
    deadline: BigInt(now + 120),
  });
  return signRelayRequest(o.requestSigner ?? o.signer, {
    sender: o.account,
    data,
    ...(o.authorization ? { authorization: o.authorization } : {}),
    auth: {
      chainId: 5003,
      sponsor: RELAYER_ADDRESS,
      entry: book.caliburEntry,
      validAfter: now - 5,
      validUntil: now + 60,
      ...o.auth,
    },
  });
}
