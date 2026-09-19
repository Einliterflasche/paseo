import { afterEach, describe, expect, it } from "vitest";
import {
  openServiceRegistration,
  type ExternalServiceInput,
  type RegistrationFormSnapshot,
} from "./registration-form";
import { deferred } from "./test-support";

type Form = ReturnType<typeof openServiceRegistration>;
type Save = Parameters<Form["submit"]>[0];
type SaveReply = Awaited<ReturnType<Save>>;
const forms: Form[] = [];

function open(
  snapshot: RegistrationFormSnapshot = { workspaceId: null, workspaceLabel: "This host" },
) {
  const form = openServiceRegistration(snapshot);
  forms.push(form);
  return form;
}

function fixture() {
  const form = open({ workspaceId: "workspace-a", workspaceLabel: "Workspace A" });
  const inputs: ExternalServiceInput[] = [];
  const reply = deferred<SaveReply>();
  const save: Save = (input) => {
    inputs.push(input);
    return reply.promise;
  };
  return { form, inputs, reply, save };
}

function enterValidValues(form: Form) {
  form.setName("Atlas React");
  form.setPort("5173");
}

afterEach(() => {
  for (const form of forms.splice(0)) form.close();
});

describe("external service registration form", () => {
  it("opens fresh values and captures workspace identity and label independently of later snapshots", () => {
    const snapshot = { workspaceId: "workspace-a", workspaceLabel: "Workspace A" };
    const first = open(snapshot);
    expect(first.getState()).toEqual({
      values: {
        name: "",
        port: "",
        workspaceId: "workspace-a",
        workspaceLabel: "Workspace A",
      },
      canSubmit: false,
      operation: { status: "editing" },
    });
    snapshot.workspaceLabel = "Changed elsewhere";
    enterValidValues(first);
    first.setWorkspace({ id: "workspace-b", label: "Captured workspace label" });

    const second = open();
    expect(second.getState()).toEqual({
      values: {
        name: "",
        port: "",
        workspaceId: null,
        workspaceLabel: "This host",
      },
      canSubmit: false,
      operation: { status: "editing" },
    });
    expect(first.getState().values).toEqual({
      name: "Atlas React",
      port: "5173",
      workspaceId: "workspace-b",
      workspaceLabel: "Captured workspace label",
    });
  });

  it.each(["", "   ", "0", "65536", "-1", "1.5", "1e3", "0x10", "5173abc"])(
    "does not call save for an invalid TCP port: %j",
    async (port) => {
      const { form, inputs, save } = fixture();
      form.setName("Atlas");
      form.setPort(port);
      expect(form.getState().canSubmit).toBe(false);
      expect(await form.submit(save)).toBe(false);
      expect(inputs).toEqual([]);
      expect(form.getState().operation).toEqual({ status: "editing" });
    },
  );

  it.each(["1", "65535"])("accepts the TCP port boundary %s", async (port) => {
    const { form, inputs, reply, save } = fixture();
    form.setName("Atlas");
    form.setPort(port);
    expect(form.getState().canSubmit).toBe(true);
    const saving = form.submit(save);
    expect(inputs).toEqual([
      { name: "Atlas", port: Number(port), workspaceId: "workspace-a", mount: "strip" },
    ]);
    reply.resolve({ result: { status: "ok", serviceId: "registered-atlas" } });
    expect(await saving).toBe(true);
  });

  it("requires a nonblank name and submits canonical values without losing their display text", async () => {
    const { form, inputs, reply, save } = fixture();
    form.setName("  ");
    form.setPort(" 05173 ");
    expect(await form.submit(save)).toBe(false);
    expect(inputs).toEqual([]);
    form.setName("  Atlas React  ");
    form.setWorkspace({ id: null, label: "Entire host" });
    const saving = form.submit(save);
    expect(inputs).toEqual([
      { name: "Atlas React", port: 5173, workspaceId: null, mount: "strip" },
    ]);
    reply.resolve({ result: { status: "ok", serviceId: "registered-atlas" } });
    expect(await saving).toBe(true);
    expect(form.getState()).toEqual({
      values: {
        name: "  Atlas React  ",
        port: " 05173 ",
        workspaceId: null,
        workspaceLabel: "Entire host",
      },
      canSubmit: false,
      operation: { status: "saved", serviceId: "registered-atlas" },
    });
    const saved = form.getState();
    form.setName("Unintended second registration");
    expect(await form.submit(save)).toBe(false);
    expect(form.getState()).toBe(saved);
    expect(inputs).toHaveLength(1);
  });

  it("owns a single save during double submit and reentrant saving publication, and freezes pending edits", async () => {
    const { form, inputs, reply, save } = fixture();
    enterValidValues(form);
    const reentrant: Promise<boolean>[] = [];
    const stop = form.subscribe(() => {
      if (form.getState().operation.status === "saving") reentrant.push(form.submit(save));
    });
    const saving = form.submit(save);
    expect(form.getState().operation).toEqual({ status: "saving" });
    expect(form.getState().canSubmit).toBe(false);
    expect(reentrant).toHaveLength(1);
    expect(await reentrant[0]).toBe(false);
    expect(await form.submit(save)).toBe(false);
    const pending = form.getState();
    form.setName("Changed");
    form.setPort("9000");
    form.setWorkspace({ id: null, label: "Entire host" });
    expect(form.getState()).toBe(pending);
    expect(inputs).toEqual([
      { name: "Atlas React", port: 5173, workspaceId: "workspace-a", mount: "strip" },
    ]);
    reply.resolve({ result: { status: "ok", serviceId: "registered-atlas" } });
    expect(await saving).toBe(true);
    expect(form.getState().operation).toEqual({ status: "saved", serviceId: "registered-atlas" });
    stop();
  });

  it.each(["already-registered", "unknown-workspace", "storage-error"] as const)(
    "preserves server failure %s and permits only an explicit retry with the existing values",
    async (code) => {
      const { form, inputs, reply, save } = fixture();
      enterValidValues(form);
      const saving = form.submit(save);
      reply.resolve({ result: { status: "error", code } });
      expect(await saving).toBe(false);
      expect(form.getState()).toEqual({
        values: {
          name: "Atlas React",
          port: "5173",
          workspaceId: "workspace-a",
          workspaceLabel: "Workspace A",
        },
        canSubmit: true,
        operation: { status: "error", code },
      });
      expect(inputs).toHaveLength(1);
      const retryInputs: ExternalServiceInput[] = [];
      expect(
        await form.submit(async (input) => {
          retryInputs.push(input);
          return { result: { status: "ok", serviceId: "retried-atlas" } };
        }),
      ).toBe(true);
      expect(retryInputs).toEqual(inputs);
      expect(form.getState().operation).toEqual({ status: "saved", serviceId: "retried-atlas" });
    },
  );

  it.each(["throw", "reject"] as const)(
    "shows a connection error when the save callback can %s",
    async (outcome) => {
      const form = open();
      enterValidValues(form);
      const error = new Error("Fixture connection unavailable");
      const inputs: ExternalServiceInput[] = [];
      expect(
        await form.submit((input) => {
          inputs.push(input);
          if (outcome === "throw") throw error;
          return Promise.reject(error);
        }),
      ).toBe(false);
      expect(inputs).toHaveLength(1);
      expect(form.getState().operation).toEqual({ status: "error", code: "connection-ended" });
      expect(form.getState().canSubmit).toBe(true);
      form.setPort("9000");
      expect(form.getState().operation).toEqual({ status: "editing" });
      expect(form.getState().values.port).toBe("9000");
    },
  );

  it("cannot begin saving when a saving subscriber synchronously closes the form", async () => {
    const { form, inputs, save } = fixture();
    enterValidValues(form);
    const operations: string[] = [];
    form.subscribe(() => {
      const status = form.getState().operation.status;
      operations.push(status);
      if (status === "saving") form.close();
    });
    expect(await form.submit(save)).toBe(false);
    expect(inputs).toEqual([]);
    expect(operations).toEqual(["saving", "closed"]);
    expect(form.getState().operation).toEqual({ status: "closed" });
    expect(form.getState().canSubmit).toBe(false);
  });

  it.each(["success", "server-error", "rejection"] as const)(
    "keeps a closed form terminal after late save %s",
    async (outcome) => {
      const { form, inputs, reply, save } = fixture();
      enterValidValues(form);
      const operations: string[] = [];
      form.subscribe(() => operations.push(form.getState().operation.status));
      const saving = form.submit(save);
      form.close();
      const closed = form.getState();
      expect(operations).toEqual(["saving", "closed"]);
      if (outcome === "rejection") reply.reject(new Error("Late connection failure"));
      else
        reply.resolve({
          result:
            outcome === "success"
              ? { status: "ok", serviceId: "late-atlas" }
              : { status: "error", code: "storage-error" },
        });
      expect(await saving).toBe(false);
      expect(form.getState()).toBe(closed);
      expect(operations).toEqual(["saving", "closed"]);
      expect(inputs).toHaveLength(1);
      expect(await form.submit(save)).toBe(false);
      expect(inputs).toHaveLength(1);
    },
  );

  it("ignores edits, repeated Close and Submit after closing an editing form", async () => {
    const { form, inputs, save } = fixture();
    enterValidValues(form);
    const operations: string[] = [];
    form.subscribe(() => operations.push(form.getState().operation.status));
    form.close();
    const closed = form.getState();
    form.setName("Changed");
    form.setPort("9000");
    form.setWorkspace({ id: null, label: "Entire host" });
    form.close();
    expect(await form.submit(save)).toBe(false);
    expect(inputs).toEqual([]);
    expect(form.getState()).toBe(closed);
    expect(operations).toEqual(["closed"]);
  });
});
