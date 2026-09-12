export function SessionExecutionMode({
  mode,
  onModeChange,
}: {
  mode: "repository" | "workspace";
  onModeChange: (mode: "repository" | "workspace") => void;
}) {
  return (
    <fieldset className="space-y-2" data-pw="create-session-mode">
      <legend className="text-sm font-medium">Execution location</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="radio"
          name="executionMode"
          value="repository"
          checked={mode === "repository"}
          onChange={() => onModeChange("repository")}
          data-pw="create-session-mode-repository"
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
          data-pw="create-session-mode-workspace"
        />
        Non-git workspace
      </label>
    </fieldset>
  );
}
