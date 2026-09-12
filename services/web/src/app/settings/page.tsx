import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SettingsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = searchParams ? await searchParams : {};
  const result =
    query.slackOAuth === "success" || query.slackOAuth === "error" ? query.slackOAuth : undefined;
  redirect(
    result ? `/settings/slack?slackOAuth=${encodeURIComponent(result)}` : "/settings/account",
  );
}
