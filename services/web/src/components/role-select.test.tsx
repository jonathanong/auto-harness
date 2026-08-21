// @vitest-environment happy-dom

import React from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm } from "./form-test-helpers.tsx";
import { RoleSelect } from "./role-select.tsx";

describe("RoleSelect", () => {
  it("lists human roles without agent, and service roles with agent", () => {
    const humans = mountForm(<RoleSelect id="human-role" pw="human-role" />);
    const humanOptions = [...field<HTMLSelectElement>(humans.container, "human-role").options].map(
      (option) => option.value,
    );
    expect(humanOptions).toEqual(["read-only", "author", "operator", "maintainer", "admin"]);
    expect(humanOptions).not.toContain("agent");
    humans.unmount();

    const services = mountForm(<RoleSelect id="service-role" includeAgent pw="service-role" />);
    const serviceOptions = [
      ...field<HTMLSelectElement>(services.container, "service-role").options,
    ].map((option) => option.value);
    expect(serviceOptions).toContain("agent");
    expect(field<HTMLSelectElement>(services.container, "service-role").textContent).toContain(
      "Host daemon",
    );
  });
});
