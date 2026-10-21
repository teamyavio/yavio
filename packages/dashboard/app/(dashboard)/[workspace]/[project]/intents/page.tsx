import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ workspace: string; project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The Intents page merged into the invocation list (#44). Bookmarks and
 * older links land on the new page with their filters intact.
 */
export default async function IntentsPage({ params, searchParams }: PageProps) {
  const { workspace, project } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) query.set(key, first);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  redirect(`/${encodeURIComponent(workspace)}/${encodeURIComponent(project)}/invocations${suffix}`);
}
