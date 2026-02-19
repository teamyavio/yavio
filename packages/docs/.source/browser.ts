// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "07-concepts/01-events.mdx": () => import("../content/docs/07-concepts/01-events.mdx?collection=docs"), "07-concepts/02-metrics.mdx": () => import("../content/docs/07-concepts/02-metrics.mdx?collection=docs"), "07-concepts/03-traces.mdx": () => import("../content/docs/07-concepts/03-traces.mdx?collection=docs"), "07-concepts/04-security.mdx": () => import("../content/docs/07-concepts/04-security.mdx?collection=docs"), "07-concepts/index.mdx": () => import("../content/docs/07-concepts/index.mdx?collection=docs"), "09-contributing/01-development-setup.mdx": () => import("../content/docs/09-contributing/01-development-setup.mdx?collection=docs"), "09-contributing/02-architecture.mdx": () => import("../content/docs/09-contributing/02-architecture.mdx?collection=docs"), "09-contributing/03-project-structure.mdx": () => import("../content/docs/09-contributing/03-project-structure.mdx?collection=docs"), "09-contributing/04-testing.mdx": () => import("../content/docs/09-contributing/04-testing.mdx?collection=docs"), "09-contributing/05-code-style.mdx": () => import("../content/docs/09-contributing/05-code-style.mdx?collection=docs"), "09-contributing/06-specs-guide.mdx": () => import("../content/docs/09-contributing/06-specs-guide.mdx?collection=docs"), "09-contributing/index.mdx": () => import("../content/docs/09-contributing/index.mdx?collection=docs"), }),
};
export default browserCollections;