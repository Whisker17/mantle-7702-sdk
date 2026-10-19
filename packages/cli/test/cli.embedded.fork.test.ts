import { join } from "node:path";
import { readProfiles } from "@0xwh1sker/mantle-aa-sdk";
import { startEmbeddedSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import { type Address, toHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFor, startFork } from "../../sdk/test/account/fork.js";
import { cli, tempHome, testEnv } from "./helpers.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const relayer = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 3,
});
const RELAYER_KEY = toHex(relayer.getHdKey().privateKey as Uint8Array);

describe.skipIf(!rpcUrl)(
  "two embedded-sponsor commands with one home (Mantle Sepolia fork)",
  () => {
    let anvil: string;
    let stop: () => void;

    beforeAll(async () => {
      ({ url: anvil, stop } = await startFork(rpcUrl as string));
    }, 120_000);
    afterAll(() => stop?.());

    it("the second fails before sending anything while the first one's sponsor runs", async () => {
      const client = clientFor(anvil);
      const home = tempHome();
      const env = testEnv(home, {
        MANTLE_AA_RPC_URL: anvil,
        MANTLE_AA_EMBEDDED_RELAYER: "1",
        MANTLE_AA_RELAYER_KEY: RELAYER_KEY,
      });
      expect((await cli(["keys", "new", "--name", "root"], env)).code).toBe(0);
      const profiles = env.MANTLE_AA_HOME as string;
      const account = readProfiles({ home: profiles }).root?.account as Address;
      const relayerTxs = () => client.getTransactionCount({ address: relayer.address });
      const before = await relayerTxs();

      // What the first command runs while it submits: the embedded sponsor on the home's ledger.
      const first = await startEmbeddedSponsor({
        rpcUrl: anvil,
        allowlist: [account],
        database: join(profiles, "embedded-sponsor.sqlite"),
        env,
      });
      let running = true;
      try {
        const second = await cli(["account", "init"], env);
        expect(second.code).toBe(1);
        expect(second.json.error.message).toMatch(
          /embedded-sponsor\.sqlite is in use by another running sponsor/,
        );
        expect(second.stdout + second.stderr).not.toContain(RELAYER_KEY.slice(2));
        expect(await relayerTxs()).toBe(before);
        expect(await client.getCode({ address: account })).toBeUndefined();

        await first.close();
        running = false;
        // Once the first command's sponsor has stopped, the same command goes through.
        const retried = await cli(["account", "init"], env);
        expect(retried.code, retried.stdout).toBe(0);
        expect(retried.json.result).toMatchObject({ state: "INITIALIZED" });
        expect((await relayerTxs()) - before).toBe(1);
      } finally {
        if (running) await first.close();
      }
    }, 300_000);
  },
);
