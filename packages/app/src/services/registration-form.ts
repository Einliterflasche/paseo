import type {
  ServiceExternalRegisterRequest,
  ServiceExternalResponseMessage,
} from "@getpaseo/protocol/messages";

export type ExternalServiceInput = Omit<ServiceExternalRegisterRequest, "type" | "requestId">;
type RegistrationResult = ServiceExternalResponseMessage["payload"]["result"];
export type RegistrationFailure =
  | Extract<RegistrationResult, { status: "error" }>["code"]
  | "connection-ended";

interface FormValues {
  name: string;
  port: string;
  workspaceId: string | null;
  workspaceLabel: string;
}

export interface RegistrationFormSnapshot {
  workspaceId: string | null;
  workspaceLabel: string;
}

export interface RegistrationFormState {
  values: Readonly<FormValues>;
  canSubmit: boolean;
  operation:
    | { status: "editing" }
    | { status: "saving" }
    | { status: "saved"; serviceId: string }
    | { status: "error"; code: RegistrationFailure }
    | { status: "closed" };
}

function parsedPort(port: string): number | null {
  if (!/^\d+$/.test(port.trim())) return null;
  const value = Number(port);
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

/** A form instance owns its edits and one explicit registration at a time. */
export function openServiceRegistration(snapshot: RegistrationFormSnapshot) {
  const listeners = new Set<() => void>();
  let state: RegistrationFormState = {
    values: {
      name: "",
      port: "",
      workspaceId: snapshot.workspaceId,
      workspaceLabel: snapshot.workspaceLabel,
    },
    canSubmit: false,
    operation: { status: "editing" },
  };

  function publish(values: FormValues, operation: RegistrationFormState["operation"]) {
    const editing = operation.status === "editing" || operation.status === "error";
    state = {
      values,
      operation,
      canSubmit: editing && values.name.trim().length > 0 && parsedPort(values.port) !== null,
    };
    for (const listener of listeners) listener();
  }

  function edit(values: Partial<FormValues>) {
    if (state.operation.status !== "editing" && state.operation.status !== "error") return;
    publish({ ...state.values, ...values }, { status: "editing" });
  }

  function isClosed() {
    return state.operation.status === "closed";
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setName: (name: string) => edit({ name }),
    setPort: (port: string) => edit({ port }),
    setWorkspace(workspace: { id: string | null; label: string }) {
      edit({ workspaceId: workspace.id, workspaceLabel: workspace.label });
    },
    async submit(save: (input: ExternalServiceInput) => Promise<{ result: RegistrationResult }>) {
      const port = parsedPort(state.values.port);
      if (!state.canSubmit || port === null) return false;
      const values = { ...state.values };
      publish(values, { status: "saving" });
      if (isClosed()) return false;
      try {
        const { result } = await save({
          name: values.name.trim(),
          port,
          workspaceId: values.workspaceId,
          mount: "strip",
        });
        if (isClosed()) return false;
        if (result.status === "error") {
          publish(values, { status: "error", code: result.code });
          return false;
        }
        publish(values, { status: "saved", serviceId: result.serviceId });
        return true;
      } catch {
        if (!isClosed()) {
          publish(values, { status: "error", code: "connection-ended" });
        }
        return false;
      }
    },
    close() {
      if (state.operation.status === "closed") return;
      publish({ ...state.values }, { status: "closed" });
      listeners.clear();
    },
  };
}
