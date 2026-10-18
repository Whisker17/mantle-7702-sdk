import { type ChildProcess, spawn } from "node:child_process";
import { createClient, createWalletClient, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  caliburDomain,
  delegationDesignator,
  getCaliburDomain,
  loadDeployments,
  mantleSepolia,
  PrivateKeySigner,
  readCaliburDomain,
} from "../src/index.js";

// Forks Mantle Sepolia with anvil; skipped when MANTLE_SEPOLIA_RPC_URL is unset.
const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
// anvil's funded development key #1, used only to pay for the type-4 transaction.
const SPONSOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

describe.skipIf(!rpcUrl)("Calibur domain on a Mantle Sepolia fork", () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const url = `http://127.0.0.1:${port}`;
  let anvil: ChildProcess;

  beforeAll(async () => {
    anvil = spawn("anvil", [
      "--fork-url",
      rpcUrl as string,
      "--port",
      String(port),
      "--hardfork",
      "prague",
    ]);
    await new Promise<void>((resolve, reject) => {
      anvil.once("error", reject);
      anvil.once("exit", (code) => reject(new Error(`anvil exited with ${code}`)));
      anvil.stdout?.on("data", (data) => String(data).includes("Listening on") && resolve());
    });
  }, 60_000);
  afterAll(() => {
    anvil?.kill();
  });

  it("offline domain equals eip712Domain() after delegation", async () => {
    const { caliburEntry } = loadDeployments();
    const client = createClient({ chain: mantleSepolia, transport: http(url) }).extend(
      publicActions,
    );
    expect(await client.getChainId()).toBe(5003);

    // The implementation's own domain.
    expect(await readCaliburDomain(client, caliburEntry)).toEqual(
      caliburDomain({ chainId: 5003, account: caliburEntry, implementation: caliburEntry }),
    );

    // A fresh EOA: computed offline before delegation.
    const root = new PrivateKeySigner(generatePrivateKey());
    const params = { account: root.address, implementation: caliburEntry, chainId: 5003 };
    const offline = await getCaliburDomain(client, params);
    expect(offline).toEqual(caliburDomain(params));

    // Delegate it to CaliburEntry with a sponsored EIP-7702 transaction.
    const authorization = await root.signAuthorization({
      address: caliburEntry,
      chainId: 5003,
      nonce: await client.getTransactionCount({ address: root.address }),
    });
    const wallet = createWalletClient({
      account: privateKeyToAccount(SPONSOR_KEY),
      chain: mantleSepolia,
      transport: http(url),
    });
    const hash = await wallet.sendTransaction({
      to: root.address,
      authorizationList: [authorization],
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    expect((await client.getCode({ address: root.address }))?.toLowerCase()).toBe(
      delegationDesignator(caliburEntry),
    );

    // Now read from chain: identical to the offline computation.
    const onchain = await getCaliburDomain(client, params);
    expect(onchain).toEqual(await readCaliburDomain(client, root.address));
    expect(onchain).toEqual(offline);
  }, 120_000);
});
