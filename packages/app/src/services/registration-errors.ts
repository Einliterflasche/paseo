import type { RegistrationFailure } from "./registration-form";

export function registrationErrorKey(code: RegistrationFailure) {
  const keys = {
    unavailable: "services.registration.unavailable",
    restarting: "services.registration.restarting",
    "unknown-registration": "services.registration.unknownRegistration",
    "unknown-workspace": "services.registration.unknownWorkspace",
    "already-registered": "services.registration.duplicate",
    "infrastructure-port": "services.registration.infrastructurePort",
    "invalid-input": "services.registration.invalidInput",
    "storage-error": "services.registration.storageError",
    "connection-ended": "services.registration.unknownResult",
  } as const;
  return keys[code];
}
