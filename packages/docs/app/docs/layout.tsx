import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{ title: "Yavio" }}
      sidebar={{
        banner: (
          <div className="rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200">
            <strong>Alpha (v0.1)</strong> — APIs and schemas may change without notice. Pin exact
            versions.
          </div>
        ),
      }}
    >
      {children}
    </DocsLayout>
  );
}
