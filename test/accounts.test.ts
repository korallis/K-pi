import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Credential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  ANTHROPIC_EXTRA_USAGE_WARNING,
  registerAccounts,
} from "../extensions/accounts/index.ts";
import { AccountsStore } from "../extensions/accounts/store.ts";

const EXPECTED_ANTHROPIC_WARNING = `Claude Pro/Max in this harness uses Anthropic’s subscription OAuth, same as Pi and Atomic.

Anthropic’s own docs: third-party harness usage draws from extra usage and is billed per token, not against the in-app Claude plan bar.

API keys (ANTHROPIC_API_KEY) are a separate pay-as-you-go path.

You are responsible for the seats you attach.

Continue?`;
const FIXED_TIME = new Date("2026-09-01T12:00:00.000Z");

type CommandHandler = (
  args: string,
  context: ExtensionCommandContext,
) => Promise<void>;

interface AccountsHarness {
  command: CommandHandler;
  confirmations: Array<{ title: string; message: string }>;
  context: ExtensionCommandContext;
  directory: string;
  loginCalls: Array<{ providerId: string; slotId: string }>;
  notifications: string[];
  sequence: string[];
  store: AccountsStore;
}

function oauthCredential(slotId: string): Credential {
  return {
    type: "oauth",
    access: `access-${slotId}`,
    refresh: `refresh-${slotId}`,
    expires: FIXED_TIME.getTime() + 3_600_000,
  };
}

async function harness(confirm: boolean): Promise<AccountsHarness> {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-accounts-"));
  const store = new AccountsStore(directory);
  const commands = new Map<string, CommandHandler>();
  const confirmations: Array<{ title: string; message: string }> = [];
  const loginCalls: Array<{ providerId: string; slotId: string }> = [];
  const notifications: string[] = [];
  const sequence: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
  };
  registerAccounts(
    pi as unknown as Parameters<typeof registerAccounts>[0],
    {
      store,
      now: () => FIXED_TIME,
      async login(providerId, slotId) {
        sequence.push("oauth");
        loginCalls.push({ providerId, slotId });
        return oauthCredential(slotId);
      },
    },
  );
  const context = {
    cwd: directory,
    hasUI: true,
    mode: "tui",
    ui: {
      async confirm(title: string, message: string) {
        sequence.push("confirm");
        confirmations.push({ title, message });
        return confirm;
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;
  return {
    command: commands.get("accounts")!,
    confirmations,
    context,
    directory,
    loginCalls,
    notifications,
    sequence,
    store,
  };
}

test("cancelled Anthropic warning creates no account slot", async () => {
  const subject = await harness(false);
  try {
    await subject.command("login anthropic home", subject.context);

    assert.deepEqual(subject.loginCalls, []);
    assert.deepEqual((await subject.store.read()).pools, {});
    assert.equal(subject.confirmations.length, 1);
    assert.equal(subject.confirmations[0]?.message, EXPECTED_ANTHROPIC_WARNING);
    assert.equal(ANTHROPIC_EXTRA_USAGE_WARNING, EXPECTED_ANTHROPIC_WARNING);
  } finally {
    await rm(subject.directory, { recursive: true, force: true });
  }
});

test("accepted warning is persisted and not repeated for the same slot", async () => {
  const subject = await harness(true);
  try {
    await subject.command("login anthropic home", subject.context);
    await subject.command("login anthropic home", subject.context);

    const slots = (await subject.store.read()).pools.anthropic?.slots;
    assert.equal(subject.confirmations.length, 1);
    assert.equal(subject.loginCalls.length, 2);
    assert.deepEqual(subject.sequence.slice(0, 2), ["confirm", "oauth"]);
    assert.equal(slots?.length, 1);
    assert.equal(slots?.[0]?.warningAcceptedAt, FIXED_TIME.toISOString());
  } finally {
    await rm(subject.directory, { recursive: true, force: true });
  }
});

test("Anthropic warning precedes the official OAuth window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "k-pi-accounts-oauth-"));
  const store = new AccountsStore(directory);
  const commands = new Map<string, CommandHandler>();
  const sequence: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    async exec(command: string, args: string[]) {
      sequence.push(`open:${command}:${args.at(-1)}`);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  registerAccounts(pi as unknown as Parameters<typeof registerAccounts>[0], {
    store,
    now: () => FIXED_TIME,
  });
  const context = {
    cwd: directory,
    hasUI: true,
    mode: "tui",
    signal: undefined,
    modelRegistry: {
      getProvider() {
        return {
          auth: {
            oauth: {
              async login(interaction: ProviderAuthInteraction) {
                sequence.push("oauth");
                interaction.notify({
                  type: "auth_url",
                  url: "https://example.test/oauth",
                });
                return oauthCredential("home");
              },
            },
          },
        };
      },
    },
    ui: {
      async confirm() {
        sequence.push("confirm");
        return true;
      },
      notify() {},
    },
  } as unknown as ExtensionCommandContext;
  try {
    await commands.get("accounts")!("login anthropic home", context);

    assert.deepEqual(sequence.slice(0, 2), ["confirm", "oauth"]);
    assert.match(sequence[2] ?? "", /^open:.*:https:\/\/example\.test\/oauth$/u);
    assert.equal(
      (await store.read()).pools.anthropic?.slots[0]?.id,
      "home",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two Anthropic subscription slots coexist", async () => {
  const subject = await harness(true);
  try {
    await subject.command("login anthropic home", subject.context);
    await subject.command("login anthropic work", subject.context);

    const document = await subject.store.read();
    assert.deepEqual(
      document.pools.anthropic?.slots.map((slot) => slot.id),
      ["home", "work"],
    );
    assert.deepEqual(Object.keys(await subject.store.readSecrets()).sort(), [
      "anthropic/home",
      "anthropic/work",
    ]);
  } finally {
    await rm(subject.directory, { recursive: true, force: true });
  }
});

test(
  "account metadata and secrets files use mode 0600 on POSIX",
  { skip: process.platform === "win32" },
  async () => {
    const subject = await harness(true);
    try {
      await subject.command("login anthropic home", subject.context);

      const [accountsMode, secretsMode] = await Promise.all([
        stat(subject.store.accountsPath),
        stat(subject.store.secretsPath),
      ]);
      assert.equal(accountsMode.mode & 0o777, 0o600);
      assert.equal(secretsMode.mode & 0o777, 0o600);
    } finally {
      await rm(subject.directory, { recursive: true, force: true });
    }
  },
);

test("accounts logout removes only the selected slot and secret", async () => {
  const subject = await harness(true);
  try {
    await subject.command("login anthropic home", subject.context);
    await subject.command("login anthropic work", subject.context);
    await subject.command("logout anthropic/home", subject.context);

    assert.deepEqual(
      (await subject.store.read()).pools.anthropic?.slots.map((slot) => slot.id),
      ["work"],
    );
    assert.deepEqual(Object.keys(await subject.store.readSecrets()), [
      "anthropic/work",
    ]);
  } finally {
    await rm(subject.directory, { recursive: true, force: true });
  }
});
