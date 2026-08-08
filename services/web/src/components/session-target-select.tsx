import { encodeSessionTargetOptionValue, type SessionTarget } from "../session-target.ts";

export function SessionTargetSelect({
  targets,
  id,
  name,
  dataPw,
}: {
  targets: SessionTarget[];
  id: string;
  name: string;
  dataPw: string;
}) {
  const accounts = targets.filter((t) => t.kind === "provider-account");
  const commands = targets.filter((t) => t.kind === "command");
  return (
    <select
      id={id}
      name={name}
      required
      data-pw={dataPw}
      className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
      defaultValue={targets[0] ? encodeSessionTargetOptionValue(targets[0]) : ""}
    >
      {targets.length === 0 ? (
        <option value="">(none — add a provider account or command)</option>
      ) : null}
      {accounts.length > 0 ? (
        <optgroup label="Provider accounts">
          {accounts.map((t) => (
            <option key={t.id} value={encodeSessionTargetOptionValue(t)}>
              {t.label}
            </option>
          ))}
        </optgroup>
      ) : null}
      {commands.length > 0 ? (
        <optgroup label="Commands">
          {commands.map((t) => (
            <option key={t.id} value={encodeSessionTargetOptionValue(t)}>
              {t.label}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
