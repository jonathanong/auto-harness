import { describe, expect, it } from "vitest";

import { parseRequiredEnvironment } from "./environment-requirements.ts";
import {
  repositoryAdmissionClosedMessage,
  repositoryAdmissionState,
} from "./repository-admission.ts";

describe("environment requirements", () => {
  it("normalizes valid names without observing values", () => {
    expect(parseRequiredEnvironment(undefined)).toEqual([]);
    expect(parseRequiredEnvironment(["Z_TOKEN", "A_1"])).toEqual(["A_1", "Z_TOKEN"]);
  });

  it("rejects malformed and duplicate inventories without echoing the name", () => {
    expect(() => parseRequiredEnvironment("TOKEN")).toThrow("must be a string array");
    expect(() => parseRequiredEnvironment(["TOKEN", "TOKEN"])).toThrow("duplicate");
    expect(() => parseRequiredEnvironment(["TOKEN=value"])).toThrow(
      "invalid environment variable name",
    );
    expect(() => parseRequiredEnvironment(["HARNESS_API_KEY"])).toThrow(
      "invalid environment variable name",
    );
    expect(() => parseRequiredEnvironment(["hArNeSs_api_key"])).toThrow(
      "invalid environment variable name",
    );
  });
});

describe("repository admission compatibility", () => {
  it("treats only missing legacy values as active and rejects malformed states", () => {
    expect(repositoryAdmissionState(undefined)).toBe("active");
    expect(repositoryAdmissionState("active")).toBe("active");
    expect(() => repositoryAdmissionState("future-state")).toThrow(
      "invalid repository admission state",
    );
    expect(repositoryAdmissionState("paused")).toBe("paused");
    expect(repositoryAdmissionClosedMessage("draining")).toBe("repository admission is draining");
  });
});
