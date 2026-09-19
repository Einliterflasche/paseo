import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

const preferencesSchema = z.strictObject({ view: z.enum(["grid", "list"]) });
export type ServicesPreferences = z.infer<typeof preferencesSchema>;
export type ServicesViewMode = ServicesPreferences["view"];
export const DEFAULT_PREFERENCES: ServicesPreferences = { view: "grid" };

export interface ServicesPreferenceScope {
  serverId: string;
  workspaceId?: string;
}

export interface ServicesPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function servicesPreferencesKey({ serverId, workspaceId }: ServicesPreferenceScope): string {
  // Older clients never read this feature key. Workspace layouts and core
  // settings stay outside the preference's version boundary.
  return `@paseo:services-preferences:v1:${JSON.stringify([serverId, workspaceId ?? null])}`;
}

export function servicesPreferenceOutcomeKey(scope: ServicesPreferenceScope) {
  return [servicesPreferencesKey(scope), "writeOutcome"];
}

export type ServicesPreferenceWriteOutcome = "saved" | "failed";

export function createServicesPreferencesStore(storage: ServicesPreferenceStorage) {
  return {
    readOptions(scope: ServicesPreferenceScope) {
      const key = servicesPreferencesKey(scope);
      return {
        queryKey: [key],
        queryFn: async (): Promise<ServicesPreferences> => {
          const raw = await storage.getItem(key);
          if (raw === null) return DEFAULT_PREFERENCES;
          const parsed = preferencesSchema.safeParse(JSON.parse(raw));
          if (!parsed.success) throw new Error("Invalid Services view preferences");
          // Invalid/future values stay stored until an explicit user choice.
          return parsed.data;
        },
        dataShape: "value" as const,
        staleTimeMs: 0,
        gcTime: Infinity,
        retry: false,
        networkMode: "always" as const,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      };
    },
    writeOptions(scope: ServicesPreferenceScope, client: QueryClient) {
      const key = servicesPreferencesKey(scope);
      const queryKey = [key];
      const outcomeKey = servicesPreferenceOutcomeKey(scope);
      // The latest result belongs to the preference scope, not to the lifetime
      // or garbage-collection order of individual mutation observers.
      return {
        mutationKey: queryKey,
        scope: { id: key },
        retry: false,
        networkMode: "always" as const,
        mutationFn: async (view: ServicesViewMode) => {
          client.setQueryDefaults(outcomeKey, { gcTime: Infinity });
          try {
            await client.cancelQueries({ queryKey, exact: true });
            const next: ServicesPreferences = { view };
            await storage.setItem(key, JSON.stringify(next));
            // A second surface can begin reading the old value during a write.
            // Its late result must not replace the persisted commit.
            await client.cancelQueries({ queryKey, exact: true });
            client.setQueryData(queryKey, next);
            client.setQueryData<ServicesPreferenceWriteOutcome>(outcomeKey, "saved");
          } catch (error) {
            client.setQueryData<ServicesPreferenceWriteOutcome>(outcomeKey, "failed");
            throw error;
          }
        },
      };
    },
  };
}
