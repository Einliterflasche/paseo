import { describe, expect, it, vi } from "vitest";
import { HatGlasses, ListTodo, Settings2, Zap } from "lucide-react-native";
import { getAgentFeatureIcon } from "./icons";

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => Object.assign(() => null, { displayName: name });
  return {
    Bot: icon("Bot"),
    Brain: icon("Brain"),
    HatGlasses: icon("HatGlasses"),
    ListTodo: icon("ListTodo"),
    Settings2: icon("Settings2"),
    Shield: icon("Shield"),
    ShieldAlert: icon("ShieldAlert"),
    ShieldCheck: icon("ShieldCheck"),
    ShieldEllipsis: icon("ShieldEllipsis"),
    ShieldOff: icon("ShieldOff"),
    ShieldPlus: icon("ShieldPlus"),
    ShieldQuestionMark: icon("ShieldQuestionMark"),
    Zap: icon("Zap"),
  };
});

describe("getAgentFeatureIcon", () => {
  it("maps provider feature icon ids to lucide icons", () => {
    expect(getAgentFeatureIcon("hat-glasses")).toBe(HatGlasses);
    expect(getAgentFeatureIcon("list-todo")).toBe(ListTodo);
    expect(getAgentFeatureIcon("zap")).toBe(Zap);
  });

  it("falls back to the settings icon for unknown or missing ids", () => {
    expect(getAgentFeatureIcon("unknown")).toBe(Settings2);
    expect(getAgentFeatureIcon()).toBe(Settings2);
  });
});
