import { APIPage } from "@/components/api-page";
import defaultMdxComponents from "fumadocs-ui/mdx";

export function getMDXComponents() {
  return {
    ...defaultMdxComponents,
    APIPage,
  };
}
