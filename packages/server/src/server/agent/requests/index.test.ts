import { RestartInProgressError } from "../../restart/restart-errors.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AgentRequests } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new AgentRequests(directory) };
}

test("receipt write failure cannot certify a drained restart or dispatch the message", async () => {
  const { directory } = await fixture();
  const blockedPath = path.join(directory, "not-a-directory");
  const requests = new AgentRequests(blockedPath);
  let dispatched = false;
  await expect(
    requests.send({
      agentId: "agent",
      messageId: "one",
      request: {},
      prepare: async () => {
        await writeFile(blockedPath, "preserve me");
      },
      send: async () => {
        dispatched = true;
      },
    }),
  ).rejects.toThrow();
  expect(dispatched).toBe(false);
  await expect(requests.drain()).rejects.toThrow("Request receipts could not be persisted");
});

test("concurrent and reconstructed creates return the same durable agent", async () => {
  const { requests, directory } = await fixture();
  const agents = new Set<string>();
  let creations = 0;
  const input = {
    key: "create-1",
    request: { provider: "test", cwd: "/project" },
    findAgent: async (id: string) => agents.has(id),
    create: async (id: string) => {
      creations++;
      agents.add(id);
    },
  };
  const ids = await Promise.all([requests.create(input), requests.create(input)]);
  expect(ids[0]).toBe(ids[1]);
  expect(await new AgentRequests(directory).create(input)).toBe(ids[0]);
  expect(creations).toBe(1);
});

test("recovers creation when the agent was persisted before acknowledgement failed", async () => {
  const { requests, directory } = await fixture();
  const agents = new Set<string>();
  const input = {
    key: "lost-create",
    request: {},
    findAgent: async (id: string) => agents.has(id),
    create: async (id: string) => {
      agents.add(id);
      throw new Error("acknowledgement lost");
    },
  };
  await expect(requests.create(input)).rejects.toThrow("acknowledgement lost");
  expect(await new AgentRequests(directory).create(input)).toBe([...agents][0]);
  expect(agents.size).toBe(1);
});

test("reusing a create key with different configuration is a conflict", async () => {
  const { requests } = await fixture();
  const input = {
    key: "key",
    request: { model: "a" },
    findAgent: async () => true,
    create: async () => {},
  };
  await requests.create(input);
  await expect(requests.create({ ...input, request: { model: "b" } })).rejects.toThrow(
    "agent_request_key_conflict",
  );
});

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new AgentRequests(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new AgentRequests(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("a creation failure with no stored agent can be retried", async () => {
  const { requests } = await fixture();
  let available = false;
  const input = {
    key: "unavailable",
    request: {},
    findAgent: async () => false,
    create: async () => {
      if (!available) throw new Error("provider unavailable");
    },
  };
  await expect(requests.create(input)).rejects.toThrow("provider unavailable");
  available = true;
  await expect(requests.create(input)).resolves.toEqual(expect.any(String));
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new AgentRequests(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("known restart rejection is retryable but a different payload with that ID is never dispatched", async () => {
  const { requests, directory } = await fixture();
  let calls = 0;
  const input = {
    agentId: "agent",
    messageId: "restart-send",
    request: { text: "keep me" },
    send: async () => {
      throw new RestartInProgressError();
    },
  };
  await expect(requests.send(input)).rejects.toBeInstanceOf(RestartInProgressError);
  const resumed = new AgentRequests(directory);
  await expect(
    resumed.send({
      ...input,
      request: { text: "replace me" },
      send: async () => {
        calls++;
      },
    }),
  ).rejects.toThrow("agent_request_key_conflict");
  expect(calls).toBe(0);
  await resumed.send({
    ...input,
    send: async () => {
      calls++;
    },
  });
  await resumed.send({
    ...input,
    send: async () => {
      calls++;
    },
  });
  expect(calls).toBe(1);
});
