// @vitest-environment happy-dom

import React, { act } from "react";
import { describe, expect, it } from "vitest";

import { field, mountForm, press, router } from "./form-test-helpers.tsx";
import { RepositoryAdmissionControls } from "./repository-admission-controls.tsx";

const failingRequest = async () =>
  new Response(JSON.stringify({ error: { message: "drain failed" } }), { status: 409 });
describe("RepositoryAdmissionControls", () => {
  it("pauses an active repository and refreshes", async () => {
    const requests: string[] = [];
    const request = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ admissionState: "paused" }), { status: 200 });
    };
    const view = mountForm(<RepositoryAdmissionControls repositoryId="repo/1" request={request} />);
    press(field(view.container, "repository-pause"));
    await act(async () => Promise.resolve());
    expect(requests).toEqual(["/api/v1/repositories/repo%2F1/pause"]);
    expect(router.refresh).toHaveBeenCalled();
  });

  it("requires confirmation before drain and displays API failures", async () => {
    const view = mountForm(
      <RepositoryAdmissionControls repositoryId="repo" request={failingRequest} />,
    );
    press(field(view.container, "repository-drain"));
    press(field(view.container, "repository-drain-confirm"));
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain("drain failed");
  });

  it("offers activation while paused and disables it while draining", async () => {
    const requests: string[] = [];
    const successfulRequest = async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ admissionState: "active" }), { status: 200 });
    };
    const paused = mountForm(
      <RepositoryAdmissionControls
        repositoryId="repo"
        state="paused"
        request={successfulRequest}
      />,
    );
    press(field(paused.container, "repository-activate"));
    await act(async () => Promise.resolve());
    expect(requests).toEqual(["/api/v1/repositories/repo/activate"]);
    expect(router.refresh).toHaveBeenCalled();
    paused.unmount();
    const draining = mountForm(
      <RepositoryAdmissionControls repositoryId="repo" state="draining" />,
    );
    expect(field<HTMLButtonElement>(draining.container, "repository-activate").disabled).toBe(true);
    expect(field<HTMLButtonElement>(draining.container, "repository-drain").disabled).toBe(true);
  });

  it("can dismiss drain confirmation", () => {
    const view = mountForm(<RepositoryAdmissionControls repositoryId="repo" />);
    press(field(view.container, "repository-drain"));
    press(field(view.container, "repository-drain-cancel"));
    expect(view.container.querySelector('[data-pw="repository-drain-confirm"]')).toBeNull();
  });
});
