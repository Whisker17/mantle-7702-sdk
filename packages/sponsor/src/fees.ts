import {
  type Address,
  type Client,
  type Hex,
  parseAbi,
  type SignedAuthorization,
  serializeTransaction,
  size,
} from "viem";
import { readContract } from "viem/actions";

/** Mantle's GasPriceOracle predeploy (docs/infra.md §5). */
export const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";
const gasPriceOracleAbi = parseAbi([
  "function operatorFeeScalar() view returns (uint256)",
  "function operatorFeeConstant() view returns (uint256)",
  "function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)",
  "function tokenRatio() view returns (uint256)",
]);

/** A relayer transaction, without its nonce. */
export interface RelayerTransaction {
  to: Address;
  data: Hex;
  value?: bigint;
  authorizationList?: SignedAuthorization[];
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * The most a relayer transaction can cost its sender, in wei (docs/infra.md §5, measured on Mantle
 * Sepolia):
 *
 *   gas × (maxFeePerGas + operatorFeeScalar × 100) + operatorFeeConstant
 *     + tokenRatio × GasPriceOracle.getL1FeeUpperBound(unsigned size)
 *
 * The oracle's scalars are read now, since they are system-configured. The size is that of the
 * unsigned transaction with the largest nonce a transaction can carry (uint64), whose RLP encoding
 * is the longest of any nonce.
 */
export async function relayerFeeBound(
  client: Client,
  chainId: number,
  tx: RelayerTransaction,
): Promise<bigint> {
  const unsigned = serializeTransaction({
    chainId,
    nonce: 2n ** 64n - 1n,
    ...tx,
    type: tx.authorizationList ? "eip7702" : "eip1559",
  } as never);
  const oracle = (functionName: string, args: unknown[] = []) =>
    readContract(client, {
      address: GAS_PRICE_ORACLE,
      abi: gasPriceOracleAbi,
      functionName,
      args,
    } as never) as Promise<bigint>;
  const [scalar, constant, l1UpperBound, tokenRatio] = await Promise.all([
    oracle("operatorFeeScalar"),
    oracle("operatorFeeConstant"),
    oracle("getL1FeeUpperBound", [BigInt(size(unsigned))]),
    oracle("tokenRatio"),
  ]);
  return tx.gas * (tx.maxFeePerGas + scalar * 100n) + constant + tokenRatio * l1UpperBound;
}

/** A transaction receipt as the node returns it (hex quantities), with Mantle's fee fields. */
export interface RawReceipt {
  transactionHash: Hex;
  status: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  l1Fee?: Hex | null;
  operatorFeeScalar?: Hex | null;
  operatorFeeConstant?: Hex | null;
}

/**
 * What a mined transaction cost its sender, in wei, from its receipt (docs/infra.md §5; matched
 * the sender's balance delta to the wei):
 *
 *   gasUsed × effectiveGasPrice + l1Fee + gasUsed × operatorFeeScalar × 100 + operatorFeeConstant
 *
 * A node without Mantle's fields (anvil) charges neither fee, so an absent field counts as zero.
 */
export function receiptCost(receipt: RawReceipt): bigint {
  const q = (value: Hex | null | undefined) => (value ? BigInt(value) : 0n);
  const gasUsed = q(receipt.gasUsed);
  return (
    gasUsed * q(receipt.effectiveGasPrice) +
    q(receipt.l1Fee) +
    gasUsed * q(receipt.operatorFeeScalar) * 100n +
    q(receipt.operatorFeeConstant)
  );
}

/** The raw receipt of `hash`, or null while it is not mined. */
export function getRawReceipt(client: Client, hash: Hex): Promise<RawReceipt | null> {
  return client.request({ method: "eth_getTransactionReceipt", params: [hash] }) as never;
}
