# @0xwh1sker/mantle-aa-sdk

EIP-7702 smart accounts for AI agents on Mantle, from TypeScript. A human's EOA is upgraded in
place to Uniswap Calibur; the human grants each agent its own session key, whose policy (a call
allowlist, spend caps on quote assets and MNT, a per-key inventory of what the agent bought) is
enforced on chain by `AgentPolicyHook`. A sponsor pays the gas, through a relayer
(`RelayerExecutor`) or an ERC-4337 bundler with a VerifyingPaymaster (`BundlerExecutor`).

> **Proof of concept. The contracts are not audited.** Mantle Sepolia (chain 5003) only. Do not
> use it with real funds.

## Install

```bash
npm i @0xwh1sker/mantle-aa-sdk viem
```

`viem` is a peer dependency: the SDK works on your own viem clients, so your project and the SDK
share one copy. Node 24 or later. The package ships the Mantle Sepolia address book:
`loadDeployments()` needs no arguments.

## Example

```ts
import { getChain, loadDeployments, MantleAccount, PrivateKeySigner, RelayerExecutor } from "@0xwh1sker/mantle-aa-sdk";
import { createPublicClient, type Hex, http } from "viem";

const addresses = loadDeployments(); // the deployed Mantle Sepolia contracts
const client = createPublicClient({ chain: getChain(addresses.chainId), transport: http(process.env.MANTLE_AA_RPC_URL) });
const executor = new RelayerExecutor({ client, url: process.env.MANTLE_AA_SPONSOR_URL as string });

const account = new MantleAccount({
  client,
  root: new PrivateKeySigner(process.env.ROOT_KEY as Hex), // the human's key
  executor,
  keystore: { home: process.env.MANTLE_AA_HOME as string }, // where session keys are saved
});
console.log(await account.status());
```

`account.init({ grant: { policy, agentName } })` upgrades the EOA and grants the first session;
an `AgentSession` then runs the agent's calls, which the SDK checks against the policy before
anything is sent. Each refusal is a typed error (`PolicyViolationError`, `LimitExceededError`,
…). The full walk-through, with a policy and an agent's buy:
[the SDK from TypeScript](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/usage.md#the-sdk-from-typescript).

## Related packages

- [`@0xwh1sker/mantle-aa-cli`](https://www.npmjs.com/package/@0xwh1sker/mantle-aa-cli): the
  `mantle-aa` command.
- [`@0xwh1sker/mantle-aa-sponsor`](https://www.npmjs.com/package/@0xwh1sker/mantle-aa-sponsor):
  the sponsor that pays the gas.

## Documentation

[The repository](https://github.com/Whisker17/mantle-7702-sdk): the quick start, the
[usage guide](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/usage.md), the [policy format](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/policy.md) and the
[design](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/DESIGN.md).

## License

MIT
