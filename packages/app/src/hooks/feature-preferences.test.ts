import { describe, expect, it } from "vitest";

import { resolveDraftFeatureValues, resolveFeatureValues } from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });

  it("starts a new draft with Fast off while retaining other remembered features", () => {
    expect(
      resolveDraftFeatureValues({
        features,
        persistedFeatureValues: { fast_mode: true, plan_mode: true },
        localFeatureValues: {},
      }),
    ).toEqual({ fast_mode: false, plan_mode: true });
  });

  it("keeps an explicit Fast choice in the current draft", () => {
    expect(
      resolveDraftFeatureValues({
        features,
        persistedFeatureValues: { fast_mode: false, plan_mode: true },
        localFeatureValues: { fast_mode: true },
      }),
    ).toEqual({ fast_mode: true, plan_mode: true });
  });

  const speedFeatures = [
    {
      type: "select" as const,
      id: "service_tier",
      label: "Speed",
      value: "priority",
      options: [
        { id: "default", label: "Normal", isDefault: true },
        { id: "priority", label: "Fast" },
        { id: "flex", label: "Flex" },
      ],
    },
    features[1]!,
  ];

  it.each(["priority", "flex"])(
    "starts a new draft at Normal instead of remembered native speed %s",
    (serviceTier) => {
      expect(
        resolveDraftFeatureValues({
          features: speedFeatures,
          persistedFeatureValues: { service_tier: serviceTier, fast_mode: true, plan_mode: true },
          localFeatureValues: {},
        }),
      ).toEqual({ service_tier: "default", plan_mode: true });
    },
  );

  it("overrides a provider's native Fast catalog default for a fresh draft", () => {
    expect(
      resolveDraftFeatureValues({
        features: speedFeatures,
        persistedFeatureValues: {},
        localFeatureValues: {},
      }),
    ).toEqual({ service_tier: "default" });
  });

  it("keeps an explicitly selected native tier in the current draft", () => {
    expect(
      resolveDraftFeatureValues({
        features: speedFeatures,
        persistedFeatureValues: { service_tier: "default", plan_mode: true },
        localFeatureValues: { service_tier: "priority" },
      }),
    ).toEqual({ service_tier: "priority", plan_mode: true });
  });

  it("preserves remembered native speed outside draft defaults", () => {
    expect(
      resolveFeatureValues({
        features: speedFeatures,
        persistedFeatureValues: { service_tier: "priority" },
        localFeatureValues: {},
      }),
    ).toEqual({ service_tier: "priority" });
  });
});
