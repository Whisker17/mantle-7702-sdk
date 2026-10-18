import { mantleSepolia } from "@mantle-aa/sdk";
import {
  type Address,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import { GAS_PRICE_ORACLE, type RawReceipt, receiptCost, relayerFeeBound } from "../src/fees.js";

/**
 * Two relayer transactions of the 0.1.0 spike on Mantle Sepolia (docs/infra.md §5): their receipts,
 * the sender's balance delta across each block (`cast balance --block N-1` minus `--block N`), and
 * the GasPriceOracle's values at block N-1 for the size `relayerFeeBound` asks about.
 */
const SPIKE = [
  {
    kind: "type-4 grant",
    receipt: {
      transactionHash: "0x67a69667f88cc4c93cf558de5898c812b778b77301ca774b1e39e6d36647ea9f",
      status: "0x1",
      gasUsed: "0x6b13d",
      effectiveGasPrice: "0xba4d40a80",
      l1Fee: "0x5f66556",
      operatorFeeScalar: "0x5f5e100",
      operatorFeeConstant: "0x0",
    },
    balanceDelta: 26_319_725_990_033_878n,
    tx: {
      to: "0xc83b1ff2ea0cd2dea813f9757bb7a029c71c21a9",
      dataBytes: 1924,
      gas: 576_208n,
      maxFeePerGas: 100_010_000_000n,
      maxPriorityFeePerGas: 10_000_000n,
      authorizationList: [
        {
          address: "0x6d5a5d57cb1112e931bac1c636e0964cf7234f04",
          chainId: 5003,
          nonce: 0,
          r: "0x49d1987f7c88c44693d2278dc67f6032755d8db546b2843fd1fccb60af049041",
          s: "0x60129ef88065977b2e6396b7eef91a934232546c196bf253a57ae4bf2d1e95e1",
          yParity: 1,
        },
      ],
    },
    oracle: { size: 2075n, l1FeeUpperBound: 79_847n },
  },
  {
    kind: "session call",
    receipt: {
      transactionHash: "0xea6530cd7b214bbb0ddb70df8c20a96fca4cb1f4e66bdeb39ead4ad00fe6aa7c",
      status: "0x1",
      gasUsed: "0x1c58c",
      effectiveGasPrice: "0xba4d40a80",
      l1Fee: "0x360bb56",
      operatorFeeScalar: "0x5f5e100",
      operatorFeeConstant: "0x0",
    },
    balanceDelta: 6_967_641_136_671_062n,
    tx: {
      to: "0xc83b1ff2ea0cd2dea813f9757bb7a029c71c21a9",
      dataBytes: 804,
      gas: 152_297n,
      maxFeePerGas: 100_010_000_000n,
      maxPriorityFeePerGas: 10_000_000n,
    },
    oracle: { size: 859n, l1FeeUpperBound: 33_774n },
  },
] as const;
const OPERATOR_FEE_SCALAR = 100_000_000n;
const TOKEN_RATIO = 4578n;

const oracleAbi = parseAbi([
  "function operatorFeeScalar() view returns (uint256)",
  "function operatorFeeConstant() view returns (uint256)",
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function tokenRatio() view returns (uint256)",
]);

/** A client whose only chain is the oracle, answering with the recorded values. */
function oracleClient(expectedSize: bigint, l1FeeUpperBound: bigint) {
  return createClient({
    chain: mantleSepolia,
    transport: custom({
      async request({ method, params }) {
        const [call] = params as [{ to: Address; data: Hex }];
        if (method !== "eth_call" || call.to.toLowerCase() !== GAS_PRICE_ORACLE.toLowerCase()) {
          throw new Error(`unexpected ${method}`);
        }
        const { functionName, args } = decodeFunctionData({ abi: oracleAbi, data: call.data });
        const value = {
          operatorFeeScalar: OPERATOR_FEE_SCALAR,
          operatorFeeConstant: 0n,
          tokenRatio: TOKEN_RATIO,
          getL1FeeUpperBound: l1FeeUpperBound,
        }[functionName];
        if (functionName === "getL1FeeUpperBound") expect(args?.[0]).toBe(expectedSize);
        return encodeFunctionResult({ abi: oracleAbi, functionName, result: value } as never);
      },
    }),
  });
}

describe("receiptCost", () => {
  it.each(SPIKE)("is what the sender paid for the spike's $kind, to the wei", (spike) => {
    expect(receiptCost(spike.receipt as RawReceipt)).toBe(spike.balanceDelta);
  });

  it("counts absent Mantle fields (anvil) as zero", () => {
    expect(
      receiptCost({
        transactionHash: "0x00",
        status: "0x0",
        gasUsed: "0x5208",
        effectiveGasPrice: "0x3b9aca00",
      }),
    ).toBe(21_000n * 1_000_000_000n);
  });
});

describe("relayerFeeBound", () => {
  it.each(SPIKE)("bounds the spike's $kind as docs/infra.md §5 states", async (spike) => {
    const { dataBytes, ...rest } = spike.tx;
    const tx = {
      ...rest,
      to: rest.to as Address,
      data: `0x${"11".repeat(dataBytes)}` as Hex,
      ...("authorizationList" in rest
        ? { authorizationList: rest.authorizationList.map((a) => ({ ...a })) }
        : {}),
    } as Parameters<typeof relayerFeeBound>[2];
    const { size, l1FeeUpperBound } = spike.oracle;
    const bound = await relayerFeeBound(oracleClient(size, l1FeeUpperBound), 5003, tx);
    // gasLimit × (maxFeePerGas + operatorFeeScalar × 100) + operatorFeeConstant
    //   + tokenRatio × getL1FeeUpperBound(size)
    expect(bound).toBe(
      tx.gas * (tx.maxFeePerGas + OPERATOR_FEE_SCALAR * 100n) + TOKEN_RATIO * l1FeeUpperBound,
    );
    expect(bound).toBeGreaterThanOrEqual(spike.balanceDelta);
    // The L1 part alone covers the L1 fee the receipt charged.
    expect(TOKEN_RATIO * l1FeeUpperBound).toBeGreaterThanOrEqual(BigInt(spike.receipt.l1Fee));
  });
});
