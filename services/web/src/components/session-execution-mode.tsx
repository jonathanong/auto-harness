export function SessionExecutionMode({
  mode,
  onModeChange,
  selectorPrefix = "create-session",
}: {
  mode: "repository" | "workspace";
  onModeChange: (mode: "repository" | "workspace") => void;
  selectorPrefix?: string;
}) {
  return (
    <fieldset className="space-y-2" data-pw={`${selectorPrefix}-mode`}>
      <legend className="text-sm font-medium">Execution location</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="executionMode"
          value="repository"
          checked={mode === "repository"}
          onChange={() => onModeChange("repository")}
          data-pw={`${selectorPrefix}-mode-repository`}
        />
        Repository worktree
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="executionMode"
          value="workspace"
          checked={mode === "workspace"}
          onChange={() => onModeChange("workspace")}
          data-pw={`${selectorPrefix}-mode-workspace`}
        />
        Non-git workspace
      </label>
    </fieldset>
  );
}
