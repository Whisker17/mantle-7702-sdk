# @0xwh1sker/mantle-aa-sponsor

The sponsor that pays the gas for [`@0xwh1sker/mantle-aa-sdk`](https://www.npmjs.com/package/@0xwh1sker/mantle-aa-sdk)
accounts on Mantle. One HTTP JSON-RPC service with two paths: `sponsor_relay`, where its
relayer wallet submits an account's signed batch, and the ERC-7677 `pm_*` methods, where it signs
paymaster data for the deployed VerifyingPaymaster. It pays only for allowlisted accounts, checks
and simulates every request, and keeps per-account and daily budgets in a SQLite ledger.

> **Proof of concept. The contracts are not audited.** Mantle Sepolia (chain 5003) only. Fund
> the sponsor's wallets with testnet amounts only.

## Install

```bash
npm i @0xwh1sker/mantle-aa-sponsor
```

Node 24 or later (the ledger uses `node:sqlite`). To run the sponsor as a service, no code is
needed: `mantle-aa sponsor serve --config sponsor.yaml` from
[`@0xwh1sker/mantle-aa-cli`](https://www.npmjs.com/package/@0xwh1sker/mantle-aa-cli) is the same
sponsor.

## In your own process

```ts
import { loadConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";

const sponsor = await startSponsor(loadConfig("sponsor.yaml")); // keys come from the environment
console.log(`sponsor listening on ${sponsor.url}`);
process.once("SIGTERM", () => sponsor.close());
```

A minimal `sponsor.yaml` (relative paths resolve against the file; the deployed Mantle Sepolia
contracts are the default address book):

```yaml
chainId: 5003
rpcUrl: ${MANTLE_AA_RPC_URL}
listen: { host: 127.0.0.1, port: 8548 }
database: ./sponsor.sqlite
relayer: "0x…"                       # the relayer wallet's address, quoted
relayerKey: ${SPONSOR_RELAYER_KEY}   # its private key, only as ${VAR}
policy:
  allowlist: ["0x…"]
  accountDailyGas: 30000000
  maxFeePerRequestMnt: "0.1"
  dailyBudgetMnt: "1"
  managementReserveMnt: "0.4"
```

Keys are never written into the file, only the environment variable that holds them. Every
field, the paymaster signer and the rejection codes:
[running a sponsor](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/usage.md#running-a-sponsor). `startEmbeddedSponsor` starts the same
sponsor without a file on an ephemeral loopback port, for tests and local demos only
(`MANTLE_AA_EMBEDDED_RELAYER=1`), as the CLI's embedded mode does.

## Documentation

[The repository](https://github.com/Whisker17/mantle-7702-sdk): the quick start, the
[usage guide](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/usage.md) and the [design](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/DESIGN.md).

## License

MIT
