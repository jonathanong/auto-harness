import { encodeSessionTargetOptionValue, type SessionTarget } from "../session-target.ts";

export function SessionTargetSelect({
  targets,
  id,
  name,
  dataPw,
  optional = false,
  defaultValue,
}: {
  targets: SessionTarget[];
  id: string;
  name: string;
  dataPw: string;
  optional?: boolean;
  defaultValue?: string;
}) {
  const providers = targets.filter((t) => t.kind === "provider");
  const commands = targets.filter((t) => t.kind === "command");
  return (
    <select
      id={id}
      name={name}
      required={!optional}
      data-pw={dataPw}
      className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
      defaultValue={
        defaultValue ??
        (optional ? "" : targets[0] ? encodeSessionTargetOptionValue(targets[0]) : "")
      }
    >
      {optional ? <option value="">Choose a fallback…</option> : null}
      {targets.length === 0 ? <option value="">(none — add a provider or command)</option> : null}
      {providers.length > 0 ? (
        <optgroup label="Providers">
          {providers.map((t) => (
            <option key={t.id} value={encodeSessionTargetOptionValue(t)}>
              {t.label}
              {t.available === false ? " (unavailable)" : ""}
            </option>
          ))}
        </optgroup>
      ) : null}
      {commands.length > 0 ? (
        <optgroup label="Commands">
          {commands.map((t) => (
            <option key={t.id} value={encodeSessionTargetOptionValue(t)}>
              {t.label}
              {t.available === false ? " (unavailable)" : ""}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
