import {
  type Abi,
  type Address,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  type Hex,
  keccak256,
  type SignedAuthorization,
} from "viem";
import { generatePrivateKey } from "viem/accounts";
import { getChainId, getCode, getTransactionCount, readContract } from "viem/actions";
import { type AddressBook, loadDeployments } from "../deployments.js";
import { delegationDesignator } from "../domain.js";
import { ExecutionRevertedError } from "../errors.js";
import {
  type KeystoreOptions,
  readProfiles,
  saveKey,
  saveProfile,
  secp256k1KeyHash,
} from "../keystore.js";
import { PrivateKeySigner, type Signer } from "../signer.js";
import { agentPolicyHookAbi, caliburAbi, erc20Abi, launchpadAbi } from "./abi.js";
import { type Call, type Executor, ROOT_KEY_HASH } from "./executor.js";
import {
  type PanicOptions,
  type PanicResult,
  selfExecuteData,
  sendSelf,
  sendUndelegation,
  UndelegationFailedError,
} from "./panic.js";
import {
  type AllowancePair,
  allowancePairs,
  assertHookFlags,
  type Policy,
  removedAllowancePairs,
  SELECTORS,
  validatePolicy,
  validatePolicyUpdate,
} from "./policy.js";

/** `UNDELEGATED → DELEGATED (safe initialisation incomplete) → INITIALIZED` (docs/DESIGN.md §5.1). */
export type AccountState = "UNDELEGATED" | "DELEGATED" | "INITIALIZED";

/**
 * Calibur v1.1.0's `ERC7914.ERC20ETH`: holds an unlimited native allowance until the account calls
 * `approveNative(ERC20ETH, 0)` (I8).
 */
export const ERC20ETH: Address = "0x00000000e20E49e6dCeE6e8283A0C090578F0fb9";

/** Management batches expire 10 minutes after signing. */
export const MANAGEMENT_DEADLINE_SECONDS = 600;
/** Session keys expire 24 hours after the grant unless the caller sets an expiry. */
export const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;

export interface MantleAccountOptions {
  client: Client;
  /** The EOA's own key: the account address and the root (keyHash 0). */
  root: Signer;
  executor: Executor;
  /** Defaults to the committed Mantle Sepolia address book. */
  addresses?: AddressBook;
  keystore?: KeystoreOptions;
}

export interface GrantOptions {
  /** Profile name; the session key is saved as `<agentName>-<address>.json`. */
  agentName: string;
  /** Unix seconds; defaults to 24 hours from now. */
  expiry?: number;
}

export interface SessionGrant {
  keyHash: Hex;
  address: Address;
  agentName: string;
  keyfile: string;
  expiry: number;
  hash: Hex;
}

/** The root's explicit statement of which key's attributed inventory a disposal consumes. */
export interface ReleaseTuple {
  keyHash: Hex;
  token: Address;
  amount: bigint;
}

export interface SessionInfo {
  keyHash: Hex;
  /** The keystore profile naming this key, if any. */
  profile?: string;
  registered: boolean;
  expiry: number;
  isAdmin: boolean;
  hook: Address;
  /** Registered as a non-admin key with this SDK's hook (I6). */
  hooked: boolean;
  summary: { initialized: boolean; active: boolean; revoked: boolean };
  policy?: Policy;
  anchor?: number;
  /** Remaining spendable amount per quote asset (`address(0)` = MNT). */
  remaining: { token: Address; amount: bigint }[];
  inventory: { token: Address; amount: bigint }[];
}

export interface AccountStatus {
  account: Address;
  state: AccountState;
  /** The EOA nonce the next EIP-7702 authorization must carry. */
  authorizationNonce: number;
  /** The root lane's next Calibur nonce. */
  caliburNonce: bigint;
  sessions: SessionInfo[];
  inventory: { token: Address; balance: bigint; reserved: bigint; unallocated: bigint }[];
}

const call = (to: Address, data: Hex): Call => ({ to, value: 0n, data });
const now = () => Math.floor(Date.now() / 1000);
const MASK_160 = (1n << 160n) - 1n;

/** A human's EIP-7702 account: initialisation, session management and root execution. */
export class MantleAccount {
  readonly address: Address;
  readonly addresses: AddressBook;
  readonly #client: Client;
  readonly #root: Signer;
  readonly #executor: Executor;
  readonly #keystore: KeystoreOptions;

  constructor(options: MantleAccountOptions) {
    this.#client = options.client;
    this.#root = options.root;
    this.#executor = options.executor;
    this.#keystore = options.keystore ?? {};
    this.addresses = options.addresses ?? loadDeployments();
    this.address = getAddress(options.root.address);
  }

  /** Reads the init state from chain: the delegation and the ERC20ETH native allowance. */
  async state(): Promise<AccountState> {
    const code = (await getCode(this.#client, { address: this.address }))?.toLowerCase();
    if (!code || code === "0x") return "UNDELEGATED";
    if (code !== delegationDesignator(this.addresses.caliburEntry)) {
      throw new Error(`Account ${this.address} is not delegated to ${this.addresses.caliburEntry}`);
    }
    const allowance = await this.#read(this.address, caliburAbi, "nativeAllowance", [ERC20ETH]);
    return allowance === 0n ? "INITIALIZED" : "DELEGATED";
  }

  /**
   * Delegates the EOA to CaliburEntry and runs the safe initialisation `approveNative(ERC20ETH, 0)`,
   * optionally with the first grant in the same batch. Every call re-reads the state first, so a
   * retry after a failure (or after a front-run authorization) signs a new authorization only while
   * the account is still undelegated; the executor reads the Calibur nonce when it signs the batch.
   */
  async init(options: { grant?: GrantOptions & { policy: Policy } } = {}): Promise<{
    state: AccountState;
    hash?: Hex | undefined;
    session?: SessionGrant | undefined;
  }> {
    const state = await this.state();
    const { grant } = options;
    if (state === "INITIALIZED") {
      if (!grant) return { state };
      const session = await this.grantSession(grant.policy, grant);
      return { state, hash: session.hash, session };
    }

    let authorization: SignedAuthorization | undefined;
    if (state === "UNDELEGATED") {
      const chainId = await getChainId(this.#client);
      if (chainId !== this.addresses.chainId || chainId === 0) {
        throw new Error(
          `RPC chain id ${chainId} is not the address book's ${this.addresses.chainId}`,
        );
      }
      if (!this.#root.signAuthorization) throw new Error("The root signer cannot sign EIP-7702");
      const nonce = await getTransactionCount(this.#client, {
        address: this.address,
        blockTag: "pending",
      });
      authorization = await this.#root.signAuthorization({
        address: this.addresses.caliburEntry,
        chainId,
        nonce,
      });
    }

    const prepared = grant && (await this.#prepareGrant(grant.policy, grant));
    const calls = [
      call(
        this.address,
        encodeFunctionData({
          abi: caliburAbi,
          functionName: "approveNative",
          args: [ERC20ETH, 0n],
        }),
      ),
      ...(prepared?.calls ?? []),
    ];
    let hash: Hex;
    try {
      hash = await this.#submit(calls, authorization);
    } catch (error) {
      const after = await this.state();
      throw new Error(`Init failed; the account is ${after}; retry init: ${error}`, {
        cause: error,
      });
    }
    const after = await this.state();
    if (after !== "INITIALIZED") {
      throw new Error(`Init transaction ${hash} left the account ${after}; retry init`);
    }
    return { state: after, hash, session: prepared && this.#commitGrant(prepared.grant, hash) };
  }

  /**
   * Grants a session: a brand-new secp256k1 key, registered non-admin with the hook and an expiry,
   * and its policy, in one `revertOnFailure` batch. The key is saved before submission; its profile
   * only after the grant landed.
   */
  async grantSession(policy: Policy, options: GrantOptions): Promise<SessionGrant> {
    await this.#requireState("INITIALIZED");
    const prepared = await this.#prepareGrant(policy, options);
    return this.#commitGrant(prepared.grant, await this.#submit(prepared.calls));
  }

  /** Updates a live session's policy and resets the allowances its removed `(token, spender)` pairs allowed. */
  async updateSession(
    keyHash: Hex,
    policy: Policy,
  ): Promise<{ hash: Hex; resetAllowances: AllowancePair[] }> {
    await this.#requireState("INITIALIZED");
    await this.#assertHook();
    const [info] = await this.#sessions([keyHash], []);
    if (!info?.hooked) throw new Error(`Session ${keyHash} is not a hooked non-admin key`);
    if (!info.summary.active || !info.policy) throw new Error(`Session ${keyHash} is not active`);
    validatePolicyUpdate(info.policy, policy);
    const reset = removedAllowancePairs(info.policy, policy);
    const hash = await this.#submit([
      call(
        this.addresses.agentPolicyHook,
        encodeFunctionData({
          abi: agentPolicyHookAbi,
          functionName: "updatePolicy",
          args: [keyHash, policy],
        }),
      ),
      ...reset.map(approveZero),
    ]);
    return { hash, resetAllowances: reset };
  }

  /** Revokes a session: Calibur key removal, the hook tombstone and every allowance its policy allowed. */
  async revokeSession(keyHash: Hex): Promise<{ hash: Hex; resetAllowances: AllowancePair[] }> {
    if (BigInt(keyHash) === 0n) throw new Error("The root key cannot be revoked");
    if ((await this.state()) === "UNDELEGATED") throw new Error("The account is not delegated");
    const { calls, resetAllowances } = this.#revocation(await this.#sessions([keyHash], []));
    return { hash: await this.#submit(calls), resetAllowances };
  }

  /**
   * The emergency stop (docs/DESIGN.md §7.3). Phase 1, one transaction: every non-root key that is
   * registered on Calibur or active on the hook is revoked on both, and every allowance their
   * policies allowed is reset (each pair once). Inventory is not released: the revoked keys'
   * positions stay frozen until the root releases them. It goes through the executor (the
   * sponsor) unless `selfPay`. Phase 2 (`undelegate`, needs `selfPay`) starts only after phase 1's
   * receipt is confirmed successful; its failure throws `UndelegationFailedError`, which carries
   * the confirmed phase 1.
   */
  async panic(options: PanicOptions = {}): Promise<PanicResult> {
    if (options.undelegate && !options.selfPay) {
      throw new Error("Undelegation is sent by the root itself: it needs selfPay");
    }
    if ((await this.state()) === "UNDELEGATED") throw new Error("The account is not delegated");
    const sessions = (await this.listSessions({ tokens: [] })).filter(
      (s) => s.registered || s.summary.active,
    );
    const { calls, resetAllowances } = this.#revocation(sessions);
    let hash: Hex | null = null;
    if (calls.length && options.selfPay) {
      const result = await sendSelf(this.#client, this.#root, { data: selfExecuteData(calls) });
      if (!result.success) {
        throw new ExecutionRevertedError({
          reason: `revocation transaction ${result.hash} reverted`,
        });
      }
      hash = result.hash;
    } else if (calls.length) {
      hash = await this.#submit(calls);
    }
    const revocation: PanicResult["revocation"] = {
      status: hash ? "confirmed" : "nothing-to-revoke",
      hash,
      revokedKeys: sessions.map((s) => s.keyHash),
      resetAllowances,
    };
    if (!options.undelegate) return { revocation, undelegation: null };

    try {
      const result = await sendUndelegation(this.#client, this.#root, this.addresses.chainId);
      if (!result.success) {
        throw new ExecutionRevertedError({ reason: `transaction ${result.hash} reverted` });
      }
      // An authorization that does not apply is skipped, and its transaction still succeeds.
      if ((await this.state()) !== "UNDELEGATED") {
        throw new Error(`transaction ${result.hash} left the account delegated`);
      }
      return { revocation, undelegation: { status: "confirmed", hash: result.hash } };
    } catch (error) {
      throw new UndelegationFailedError(revocation, error);
    }
  }

  /**
   * Root execution. Disposing of meme attributed to a session needs an explicit `(keyHash, token,
   * amount)` release tuple: each is checked against that key's inventory and released in the same
   * batch, before the calls. Attribution is never inferred; a call that touches a token with
   * reservations and no release tuple only produces a warning.
   */
  async exec(
    calls: readonly Call[],
    options: { release?: readonly ReleaseTuple[] } = {},
  ): Promise<{ hash: Hex; warnings: string[] }> {
    if ((await this.state()) === "UNDELEGATED") throw new Error("The account is not delegated");
    const release = options.release ?? [];
    const totals = new Map<string, ReleaseTuple>();
    for (const r of release) {
      if (r.amount <= 0n) throw new Error("A release amount must be positive");
      if (BigInt(r.keyHash) === 0n) throw new Error("The root key holds no inventory");
      const id = `${r.keyHash.toLowerCase()}:${getAddress(r.token)}`;
      const sum = (totals.get(id)?.amount ?? 0n) + r.amount;
      totals.set(id, { ...r, amount: sum });
    }
    for (const r of totals.values()) {
      const held = await this.#inventory(r.keyHash, r.token);
      if (r.amount > held) {
        throw new Error(
          `Release of ${r.amount} ${r.token} exceeds ${r.keyHash}'s inventory ${held}`,
        );
      }
    }

    const released = new Set(release.map((r) => getAddress(r.token)));
    const warnings: string[] = [];
    for (const token of new Set(calls.flatMap(touchedTokens))) {
      if (released.has(token)) continue;
      const reserved = await this.#read(
        this.addresses.agentPolicyHook,
        agentPolicyHookAbi,
        "reserved",
        [this.address, token],
      );
      if (reserved > 0n) {
        warnings.push(
          `${token} has ${reserved} attributed to sessions; disposing of more than the unallocated balance needs a release tuple`,
        );
      }
    }

    const releaseCalls = release.map((r) =>
      call(
        this.addresses.agentPolicyHook,
        encodeFunctionData({
          abi: agentPolicyHookAbi,
          functionName: "releaseInventory",
          args: [r.keyHash, r.token, r.amount],
        }),
      ),
    );
    return { hash: await this.#submit([...releaseCalls, ...calls]), warnings };
  }

  /** Sessions known on chain (Calibur keys) or in this account's keystore profiles. */
  async listSessions(options: { tokens?: readonly Address[] } = {}): Promise<SessionInfo[]> {
    const delegated = (await this.state()) !== "UNDELEGATED";
    const keyHashes: Hex[] = [];
    if (delegated) {
      const count = await this.#read(this.address, caliburAbi, "keyCount", []);
      for (let i = 0n; i < count; i++) {
        const key = await this.#read(this.address, caliburAbi, "keyAt", [i]);
        keyHashes.push(
          keccak256(
            encodeAbiParameters(
              [{ type: "uint8" }, { type: "bytes32" }],
              [key.keyType, keccak256(key.publicKey)],
            ),
          ),
        );
      }
    }
    for (const p of Object.values(this.#profiles())) keyHashes.push(p.keyHash);
    const unique = [...new Set(keyHashes.map((k) => k.toLowerCase() as Hex))];
    return this.#sessions(unique, options.tokens ?? [this.addresses.memeToken], delegated);
  }

  /** The init state, nonces, every session with its policy, remaining limits and inventory. */
  async status(options: { tokens?: readonly Address[] } = {}): Promise<AccountStatus> {
    const tokens = (options.tokens ?? [this.addresses.memeToken]).map((t) => getAddress(t));
    const state = await this.state();
    const inventory = await Promise.all(
      tokens.map(async (token) => {
        const [balance, reserved] = await Promise.all([
          this.#read(token, erc20Abi, "balanceOf", [this.address]),
          this.#read(this.addresses.agentPolicyHook, agentPolicyHookAbi, "reserved", [
            this.address,
            token,
          ]),
        ]);
        return {
          token,
          balance,
          reserved,
          unallocated: balance > reserved ? balance - reserved : 0n,
        };
      }),
    );
    return {
      account: this.address,
      state,
      authorizationNonce: await getTransactionCount(this.#client, { address: this.address }),
      caliburNonce:
        state === "UNDELEGATED" ? 0n : await this.#read(this.address, caliburAbi, "getSeq", [0n]),
      sessions: await this.listSessions({ tokens }),
      inventory,
    };
  }

  // ---- internals ------------------------------------------------------------------------------

  /**
   * One batch revoking `sessions`: Calibur `revoke` of each registered key, the hook tombstone of
   * each key, and `approve(spender, 0)` once per allowance pair their policies allow.
   */
  #revocation(sessions: readonly SessionInfo[]): {
    calls: Call[];
    resetAllowances: AllowancePair[];
  } {
    const pairs = sessions.flatMap((s) => (s.policy ? allowancePairs(s.policy) : []));
    const resetAllowances = [...new Map(pairs.map((p) => [`${p.token}:${p.spender}`, p])).values()];
    const hookRevoke = (keyHash: Hex) =>
      call(
        this.addresses.agentPolicyHook,
        encodeFunctionData({ abi: agentPolicyHookAbi, functionName: "revoke", args: [keyHash] }),
      );
    const caliburRevoke = (keyHash: Hex) =>
      call(
        this.address,
        encodeFunctionData({ abi: caliburAbi, functionName: "revoke", args: [keyHash] }),
      );
    const calls = [
      ...sessions.filter((s) => s.registered).map((s) => caliburRevoke(s.keyHash)),
      ...sessions.map((s) => hookRevoke(s.keyHash)),
      ...resetAllowances.map(approveZero),
    ];
    return { calls, resetAllowances };
  }

  async #submit(calls: readonly Call[], authorization?: SignedAuthorization): Promise<Hex> {
    const result = await this.#executor.submit({
      account: this.address,
      keyHash: ROOT_KEY_HASH,
      calls,
      lane: 0n,
      signer: this.#root,
      deadline: BigInt(now() + MANAGEMENT_DEADLINE_SECONDS),
      ...(authorization ? { authorization } : {}),
    });
    if (!result.success) throw new Error(`Management batch reverted in transaction ${result.hash}`);
    return result.hash;
  }

  async #requireState(expected: AccountState): Promise<void> {
    const state = await this.state();
    if (state !== expected) throw new Error(`The account is ${state}, not ${expected}`);
  }

  /** I7: the hook carries all five callback flags and has code. */
  async #assertHook(): Promise<void> {
    const hook = this.addresses.agentPolicyHook;
    assertHookFlags(hook);
    const code = await getCode(this.#client, { address: hook });
    if (!code || code === "0x") throw new Error(`Hook ${hook} has no code`);
  }

  async #prepareGrant(policy: Policy, options: GrantOptions) {
    await this.#assertHook();
    validatePolicy(policy);
    const expiry = options.expiry ?? now() + DEFAULT_SESSION_TTL_SECONDS;
    if (!Number.isSafeInteger(expiry) || expiry <= now() || expiry >= 2 ** 40) {
      throw new Error(`Invalid session expiry ${expiry}`);
    }
    // Always a brand-new key, saved before anything is signed so a landed grant never loses it.
    const privateKey = generatePrivateKey();
    const address = new PrivateKeySigner(privateKey).address;
    const keyHash = secp256k1KeyHash(address);
    const keyName = `${options.agentName}-${address.toLowerCase()}`;
    saveKey(keyName, privateKey, this.#keystore);

    // I6: a non-admin key always carries the hook (admin bit 200 clear).
    const settings = BigInt(this.addresses.agentPolicyHook) | (BigInt(expiry) << 160n);
    const publicKey = encodeAbiParameters([{ type: "address" }], [address]);
    const calls = [
      call(
        this.address,
        encodeFunctionData({
          abi: caliburAbi,
          functionName: "register",
          args: [{ keyType: 2, publicKey }],
        }),
      ),
      call(
        this.address,
        encodeFunctionData({ abi: caliburAbi, functionName: "update", args: [keyHash, settings] }),
      ),
      call(
        this.addresses.agentPolicyHook,
        encodeFunctionData({
          abi: agentPolicyHookAbi,
          functionName: "setPolicy",
          args: [keyHash, policy],
        }),
      ),
    ];
    const grant = {
      keyHash,
      address,
      agentName: options.agentName,
      keyfile: `${keyName}.json`,
      expiry,
    };
    return { calls, grant };
  }

  #commitGrant(grant: Omit<SessionGrant, "hash">, hash: Hex): SessionGrant {
    saveProfile(
      grant.agentName,
      { account: this.address, keyHash: grant.keyHash, keyfile: grant.keyfile, role: "agent" },
      this.#keystore,
    );
    return { ...grant, hash };
  }

  #profiles() {
    return Object.fromEntries(
      Object.entries(readProfiles(this.#keystore)).filter(
        ([, p]) => p.role === "agent" && getAddress(p.account) === this.address,
      ),
    );
  }

  async #sessions(
    keyHashes: readonly Hex[],
    tokens: readonly Address[],
    delegated = true,
  ): Promise<SessionInfo[]> {
    const hook = this.addresses.agentPolicyHook;
    const profiles = Object.entries(this.#profiles());
    return Promise.all(
      keyHashes.map(async (keyHash) => {
        const registered =
          delegated && (await this.#read(this.address, caliburAbi, "isRegistered", [keyHash]));
        const settings = registered
          ? await this.#read(this.address, caliburAbi, "getKeySettings", [keyHash])
          : 0n;
        const summary = await this.#read(hook, agentPolicyHookAbi, "getSummary", [
          keyHash,
          this.address,
        ]);
        const isAdmin = ((settings >> 200n) & 1n) === 1n;
        const keyHook = getAddress(`0x${(settings & MASK_160).toString(16).padStart(40, "0")}`);
        const info: SessionInfo = {
          keyHash,
          registered,
          expiry: Number((settings >> 160n) & 0xffffffffffn),
          isAdmin,
          hook: keyHook,
          hooked: registered && !isAdmin && keyHook === hook,
          summary: { ...summary },
          remaining: [],
          inventory: await Promise.all(
            tokens.map(async (token) => ({
              token: getAddress(token),
              amount: await this.#inventory(keyHash, token),
            })),
          ),
        };
        const profile = profiles.find(([, p]) => p.keyHash.toLowerCase() === keyHash.toLowerCase());
        if (profile) info.profile = profile[0];
        if (summary.initialized) {
          const [policy, anchor] = await this.#read(hook, agentPolicyHookAbi, "getPolicy", [
            keyHash,
            this.address,
          ]);
          info.policy = policy;
          info.anchor = anchor;
          const assets = policy.quoteLimits.map((q) => q.token);
          if (policy.mntLimit.totalCap > 0n) assets.push(policy.mntLimit.token);
          info.remaining = await Promise.all(
            assets.map(async (token) => ({
              token,
              amount: await this.#read(hook, agentPolicyHookAbi, "remainingLimit", [
                keyHash,
                this.address,
                token,
              ]),
            })),
          );
        }
        return info;
      }),
    );
  }

  #inventory(keyHash: Hex, token: Address): Promise<bigint> {
    return this.#read(this.addresses.agentPolicyHook, agentPolicyHookAbi, "inventory", [
      keyHash,
      this.address,
      token,
    ]);
  }

  #read<
    const abi extends Abi,
    functionName extends ContractFunctionName<abi, "pure" | "view">,
    const args extends ContractFunctionArgs<abi, "pure" | "view", functionName>,
  >(
    address: Address,
    abi: abi,
    functionName: functionName,
    args: args,
  ): Promise<ContractFunctionReturnType<abi, "pure" | "view", functionName, args>> {
    return readContract(this.#client, { address, abi, functionName, args } as never) as never;
  }
}

const approveZero = ({ token, spender }: AllowancePair): Call =>
  call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] }));

/** Tokens a root call visibly touches: its target, and the token of a launchpad `sell`. */
function touchedTokens(c: Call): Address[] {
  const tokens = [getAddress(c.to)];
  if (c.data.slice(0, 10).toLowerCase() === SELECTORS.sell) {
    const { args } = decodeFunctionData({ abi: launchpadAbi, data: c.data });
    tokens.push(getAddress(args[0] as Address));
  }
  return tokens;
}
