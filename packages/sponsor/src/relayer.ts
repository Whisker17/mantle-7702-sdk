import {
  type Address,
  type Client,
  type Hex,
  isHex,
  keccak256,
  RpcError,
  RpcRequestError,
} from "viem";
import { type LocalAccount, privateKeyToAccount } from "viem/accounts";
import { getTransactionCount } from "viem/actions";
import type { SponsorConfig } from "./config.js";
import type { RelayerTransaction } from "./fees.js";

/**
 * The relayer account from the environment variable the config names (`relayerKey: ${VAR}`). It
 * must be the configured `relayer`. Errors never contain the key.
 */
export function loadRelayerAccount(
  config: Pick<SponsorConfig, "relayer" | "relayerKeyEnv">,
  env: NodeJS.ProcessEnv = process.env,
): LocalAccount {
  const name = config.relayerKeyEnv;
  if (!name) throw new Error("the config names no relayerKey");
  const key = env[name];
  if (!key || !isHex(key) || key.length !== 66) {
    throw new Error(`${name} must hold the relayer's 32-byte hex private key`);
  }
  const account = privateKeyToAccount(key);
  if (account.address !== config.relayer) {
    throw new Error(`${name} is the key of ${account.address}, not of relayer ${config.relayer}`);
  }
  return account;
}

/** The relayer's mined (`latest`) and mined-plus-queued (`pending`) transaction counts. */
export async function relayerNonces(client: Client, relayer: Address) {
  const [latest, pending] = await Promise.all([
    getTransactionCount(client, { address: relayer, blockTag: "latest" }),
    getTransactionCount(client, { address: relayer, blockTag: "pending" }),
  ]);
  return { latest, pending };
}

/** Signs a relayer transaction (type 4 when it carries an authorization, else EIP-1559). */
export async function signRelayerTransaction(
  account: LocalAccount,
  chainId: number,
  tx: RelayerTransaction & { nonce: number },
): Promise<{ hash: Hex; raw: Hex }> {
  const raw = await account.signTransaction({
    chainId,
    ...tx,
    type: tx.authorizationList ? "eip7702" : "eip1559",
  } as never);
  return { hash: keccak256(raw), raw };
}

/**
 * Sends a signed transaction. Resolves `true` once the node took it, `false` when that is unknown
 * (no answer, or an answer that the transaction or its nonce is already known); rejects only when
 * the node refused it, so nothing was broadcast.
 */
export async function broadcast(client: Client, raw: Hex): Promise<boolean> {
  try {
    await client.request({ method: "eth_sendRawTransaction", params: [raw] });
    return true;
  } catch (error) {
    // A JSON-RPC error answer is a refusal; a transport failure or a timeout leaves it unknown.
    const refused =
      (error instanceof RpcError || error instanceof RpcRequestError) &&
      !/already known|known transaction|already imported|nonce too low/i.test(error.message);
    if (refused) throw error;
    return false;
  }
}
