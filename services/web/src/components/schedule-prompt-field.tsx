import { Label, Textarea } from "@auto-harness/ui";

export function SchedulePromptField({ defaultValue }: { defaultValue?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor="prompt" tip="Prompt passed to the CLI when this schedule fires">
        prompt
      </Label>
      <Textarea
        id="prompt"
        name="prompt"
        rows={4}
        defaultValue={defaultValue}
        data-pw="schedule-prompt"
      />
    </div>
  );
}
