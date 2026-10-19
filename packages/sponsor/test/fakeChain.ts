import { mantleSepolia } from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  createClient,
  custom,
  encodeFunctionResult,
  getAddress,
  type Hex,
  HttpRequestError,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
  toHex,
} from "viem";

const BASE_FEE = 50_000_000_000n;
const oracleAbi = parseAbi([
  "function operatorFeeScalar() view returns (uint256)",
  "function operatorFeeConstant() view returns (uint256)",
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function tokenRatio() view returns (uint256)",
]);
const ORACLE = new Map<Hex, Hex>(
  (
    [
      ["operatorFeeScalar", 100_000_000n],
      ["operatorFeeConstant", 0n],
      ["getL1FeeUpperBound", 80_000n],
      ["tokenRatio", 4578n],
    ] as const
  ).map(([functionName, result]) => [
    toFunctionSelector(oracleAbi.find((f) => f.name === functionName) as never),
    encodeFunctionResult({ abi: oracleAbi, functionName, result } as never),
  ]),
);

interface Pooled {
  raw: Hex;
  hash: Hex;
  from: Address;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
}

/**
 * A chain just big enough for the ledger: per-sender nonces, a mempool that replaces a transaction
 * only for higher fees, explicit mining with chosen outcomes, receipts with Mantle's fee fields,
 * and the GasPriceOracle.
 */
export class FakeChain {
  readonly nonces = new Map<Address, number>();
  readonly pool = new Map<string, Pooled>();
  readonly receipts = new Map<Hex, Record<string, Hex | null>>();
  /** Every raw transaction the node accepted, in order. */
  readonly accepted: Hex[] = [];
  /** The next sends fail like this. */
  failSends: ("refuse" | "lose")[] = [];
  /** Gas a mined transaction uses, as a fraction of its limit (percent). */
  gasUsedPercent = 70n;

  readonly client = createClient({
    chain: mantleSepolia,
    transport: custom({ request: ({ method, params }) => this.#request(method, params as never) }),
  });

  nonce(address: Address): number {
    return this.nonces.get(address) ?? 0;
  }

  /** Mines the pooled transactions in nonce order; `revert` names hashes whose execution fails. */
  mine(revert: Hex[] = []): Hex[] {
    const mined: Hex[] = [];
    for (const tx of [...this.pool.values()].sort((a, b) => a.nonce - b.nonce)) {
      if (tx.nonce !== this.nonce(tx.from)) continue;
      this.include(tx, revert.includes(tx.hash));
      mined.push(tx.hash);
    }
    return mined;
  }

  /** Includes a pooled or any signed transaction directly (e.g. the original beating its cancel). */
  include(tx: Pooled, reverted = false): void {
    const gasUsed = tx.gas === 21_000n ? 21_000n : (tx.gas * this.gasUsedPercent) / 100n;
    const price = BASE_FEE + tx.maxPriorityFeePerGas;
    const effective = price < tx.maxFeePerGas ? price : tx.maxFeePerGas;
    this.receipts.set(tx.hash, {
      transactionHash: tx.hash,
      status: reverted ? "0x0" : "0x1",
      gasUsed: toHex(gasUsed),
      effectiveGasPrice: toHex(effective),
      l1Fee: toHex(100_000_000n),
      operatorFeeScalar: toHex(100_000_000n),
      operatorFeeConstant: "0x0",
    });
    this.pool.delete(`${tx.from}:${tx.nonce}`);
    this.nonces.set(tx.from, tx.nonce + 1);
  }

  async decode(raw: Hex): Promise<Pooled> {
    const tx = parseTransaction(raw);
    return {
      raw,
      hash: keccak256(raw),
      from: await recoverTransactionAddress({ serializedTransaction: raw as never }),
      nonce: tx.nonce as number,
      maxFeePerGas: tx.maxFeePerGas as bigint,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas as bigint,
      gas: tx.gas as bigint,
    };
  }

  /** What `receiptCost` must make of a mined transaction. */
  cost(hash: Hex): bigint {
    const r = this.receipts.get(hash) as { gasUsed: Hex; effectiveGasPrice: Hex; l1Fee: Hex };
    const gasUsed = BigInt(r.gasUsed);
    return gasUsed * BigInt(r.effectiveGasPrice) + BigInt(r.l1Fee) + gasUsed * 100_000_000n * 100n;
  }

  async #request(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return "0x138b";
      case "eth_getTransactionCount": {
        const [address, tag] = params as [Address, string];
        const from = getAddress(address);
        let n = this.nonce(from);
        if (tag === "pending") while (this.pool.has(`${from}:${n}`)) n++;
        return toHex(n);
      }
      case "eth_sendRawTransaction": {
        const fail = this.failSends.shift();
        if (fail === "lose") {
          throw new HttpRequestError({ url: "http://fake", details: "connection reset" });
        }
        if (fail === "refuse") {
          throw Object.assign(new Error("insufficient funds for gas * price + value"), {
            code: -32000,
          });
        }
        const tx = await this.decode(params[0] as Hex);
        if (this.receipts.has(tx.hash)) return tx.hash;
        if (tx.nonce < this.nonce(tx.from)) {
          throw Object.assign(new Error("nonce too low"), { code: -32000 });
        }
        const key = `${tx.from}:${tx.nonce}`;
        const old = this.pool.get(key);
        if (old?.hash === tx.hash) return tx.hash;
        if (
          old &&
          (tx.maxFeePerGas * 10n < old.maxFeePerGas * 11n ||
            tx.maxPriorityFeePerGas * 10n < old.maxPriorityFeePerGas * 11n)
        ) {
          throw Object.assign(new Error("replacement transaction underpriced"), { code: -32000 });
        }
        this.pool.set(key, tx);
        this.accepted.push(tx.raw);
        return tx.hash;
      }
      case "eth_getTransactionReceipt":
        return this.receipts.get(params[0] as Hex) ?? null;
      case "eth_call": {
        const [call] = params as [{ data: Hex }];
        return ORACLE.get(call.data.slice(0, 10) as Hex);
      }
      case "eth_getBlockByNumber":
        return { number: "0x1", hash: `0x${"11".repeat(32)}`, baseFeePerGas: toHex(BASE_FEE) };
      case "eth_maxPriorityFeePerGas":
        return toHex(1_000_000n);
      default:
        throw new Error(`unexpected RPC ${method}`);
    }
  }
}
