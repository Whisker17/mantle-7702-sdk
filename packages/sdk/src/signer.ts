import type {
  Address,
  AuthorizationRequest,
  Hex,
  SignableMessage,
  SignedAuthorization,
  TransactionSerializable,
  TypedData,
  TypedDataDefinition,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/** Anything that can sign for one secp256k1 key (docs/DESIGN.md §5.1). */
export interface Signer {
  address: Address;
  signTypedData<
    const T extends TypedData | Record<string, unknown>,
    P extends keyof T | "EIP712Domain",
  >(params: TypedDataDefinition<T, P>): Promise<Hex>;
  signMessage(params: { message: SignableMessage }): Promise<Hex>;
  signAuthorization?(params: AuthorizationRequest): Promise<SignedAuthorization>;
  /** Signs a transaction the key sends itself (a self-paid panic). */
  signTransaction?(transaction: TransactionSerializable): Promise<Hex>;
}

export class PrivateKeySigner implements Signer {
  readonly address: Address;
  readonly #account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.#account = privateKeyToAccount(privateKey);
    this.address = this.#account.address;
  }

  signTypedData<
    const T extends TypedData | Record<string, unknown>,
    P extends keyof T | "EIP712Domain",
  >(params: TypedDataDefinition<T, P>): Promise<Hex> {
    return this.#account.signTypedData(params);
  }

  signMessage(params: { message: SignableMessage }): Promise<Hex> {
    return this.#account.signMessage(params);
  }

  /** Signs an EIP-7702 authorization. A chain-agnostic (chainId 0) authorization is refused. */
  async signAuthorization(params: AuthorizationRequest): Promise<SignedAuthorization> {
    if (!params.chainId)
      throw new Error("Refusing to sign an EIP-7702 authorization without a chainId");
    return this.#account.signAuthorization(params);
  }

  signTransaction(transaction: TransactionSerializable): Promise<Hex> {
    return this.#account.signTransaction(transaction);
  }
}
