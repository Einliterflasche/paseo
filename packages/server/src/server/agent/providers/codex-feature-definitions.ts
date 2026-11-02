import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

// Codex models that accept Daybreak Blue, matched on the exact model id. Source: before
// 2026-11-02 the Codex model catalog advertised Daybreak Blue only for these models, and
// Codex 0.166 refuses Daybreak for Astra. The catalog now lags behind account approvals, so
// this list is kept by hand. docs/codex-daybreak.md has the refresh steps.
export const CODEX_DAYBREAK_MODEL_IDS: readonly string[] = [
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

export interface CodexDaybreakModel {
  id: string;
  label: string;
}

export function isCodexDaybreakModel(model: CodexDaybreakModel | null): boolean {
  return model !== null && CODEX_DAYBREAK_MODEL_IDS.includes(model.id);
}

/** Names the model in messages about Daybreak; null when Daybreak is available for it. */
export function codexDaybreakUnavailableFor(model: CodexDaybreakModel | null): string | null {
  return isCodexDaybreakModel(model) ? null : (model?.label ?? "this model");
}

function buildCodexSpeedFeature(tiers: CodexServiceTier[], value: string): AgentFeature[] {
  if (tiers.length === 0) return [];
  return [
    {
      type: "select",
      id: "service_tier",
      label: "Speed",
      description: "Choose processing speed. Faster tiers increase usage.",
      tooltip: "Select speed",
      icon: "zap",
      desktopTrigger: "icon",
      value,
      options: [
        { id: "default", label: "Normal", isDefault: true },
        ...tiers.map((tier) => ({ id: tier.id, label: tier.name })),
      ],
    },
  ];
}

export const CODEX_PLAN_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

export const CODEX_DAYBREAK_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "daybreak",
  label: "Daybreak",
  description: "Request Daybreak Blue cyber access for new turns",
  tooltip: "Toggle Daybreak",
  icon: "hat-glasses",
};

// The toggle keeps the saved choice while the model cannot use it, so switching back restores it.
function buildCodexDaybreakFeature(
  enabled: boolean,
  model: CodexDaybreakModel | null,
): AgentFeatureToggle {
  const feature = { ...CODEX_DAYBREAK_FEATURE, value: enabled };
  const unavailableFor = codexDaybreakUnavailableFor(model);
  if (unavailableFor === null) return feature;
  return { ...feature, disabledReason: `Daybreak is not available for ${unavailableFor}` };
}

export function buildCodexFeatures(input: {
  serviceTiers: CodexServiceTier[];
  serviceTier: string;
  planModeEnabled: boolean;
  planModeAvailable?: boolean;
  /** Null when the session does not run on OpenAI, which Daybreak requires. */
  daybreak: { enabled: boolean; model: CodexDaybreakModel | null } | null;
}): AgentFeature[] {
  const features = buildCodexSpeedFeature(input.serviceTiers, input.serviceTier);
  if (input.planModeAvailable !== false) {
    features.push({ ...CODEX_PLAN_MODE_FEATURE, value: input.planModeEnabled });
  }
  if (input.daybreak) {
    features.push(buildCodexDaybreakFeature(input.daybreak.enabled, input.daybreak.model));
  }
  return features;
}

export function readCodexServiceTier(values: Record<string, unknown> | undefined): string | null {
  const tier = values?.service_tier;
  if (typeof tier === "string") return tier;
  // COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast preferences have migrated.
  return values?.fast_mode ? "fast" : null;
}

/** Null means Paseo has no saved choice, so a resumed thread's own choice applies. */
export function readCodexDaybreak(values: Record<string, unknown> | undefined): boolean | null {
  const daybreak = values?.daybreak;
  return typeof daybreak === "boolean" ? daybreak : null;
}
