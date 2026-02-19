// @ts-nocheck
import * as __fd_glob_21 from "../content/docs/09-contributing/index.mdx?collection=docs"
import * as __fd_glob_20 from "../content/docs/09-contributing/06-specs-guide.mdx?collection=docs"
import * as __fd_glob_19 from "../content/docs/09-contributing/05-code-style.mdx?collection=docs"
import * as __fd_glob_18 from "../content/docs/09-contributing/04-testing.mdx?collection=docs"
import * as __fd_glob_17 from "../content/docs/09-contributing/03-project-structure.mdx?collection=docs"
import * as __fd_glob_16 from "../content/docs/09-contributing/02-architecture.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/09-contributing/01-development-setup.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/07-concepts/index.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/07-concepts/04-security.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/07-concepts/03-traces.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/07-concepts/02-metrics.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/07-concepts/01-events.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/index.mdx?collection=docs"
import { default as __fd_glob_8 } from "../content/docs/05-cli/meta.json?collection=meta"
import { default as __fd_glob_7 } from "../content/docs/09-contributing/meta.json?collection=meta"
import { default as __fd_glob_6 } from "../content/docs/08-pricing/meta.json?collection=meta"
import { default as __fd_glob_5 } from "../content/docs/07-concepts/meta.json?collection=meta"
import { default as __fd_glob_4 } from "../content/docs/06-api-reference/meta.json?collection=meta"
import { default as __fd_glob_3 } from "../content/docs/02-sdk/meta.json?collection=meta"
import { default as __fd_glob_2 } from "../content/docs/04-self-hosting/meta.json?collection=meta"
import { default as __fd_glob_1 } from "../content/docs/03-dashboard/meta.json?collection=meta"
import { default as __fd_glob_0 } from "../content/docs/01-getting-started/meta.json?collection=meta"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.doc("docs", "content/docs", {"index.mdx": __fd_glob_9, "07-concepts/01-events.mdx": __fd_glob_10, "07-concepts/02-metrics.mdx": __fd_glob_11, "07-concepts/03-traces.mdx": __fd_glob_12, "07-concepts/04-security.mdx": __fd_glob_13, "07-concepts/index.mdx": __fd_glob_14, "09-contributing/01-development-setup.mdx": __fd_glob_15, "09-contributing/02-architecture.mdx": __fd_glob_16, "09-contributing/03-project-structure.mdx": __fd_glob_17, "09-contributing/04-testing.mdx": __fd_glob_18, "09-contributing/05-code-style.mdx": __fd_glob_19, "09-contributing/06-specs-guide.mdx": __fd_glob_20, "09-contributing/index.mdx": __fd_glob_21, });

export const meta = await create.meta("meta", "content/docs", {"01-getting-started/meta.json": __fd_glob_0, "03-dashboard/meta.json": __fd_glob_1, "04-self-hosting/meta.json": __fd_glob_2, "02-sdk/meta.json": __fd_glob_3, "06-api-reference/meta.json": __fd_glob_4, "07-concepts/meta.json": __fd_glob_5, "08-pricing/meta.json": __fd_glob_6, "09-contributing/meta.json": __fd_glob_7, "05-cli/meta.json": __fd_glob_8, });