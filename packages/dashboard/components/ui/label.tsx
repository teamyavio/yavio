"use client";

import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import type { LabelHTMLAttributes } from "react";

const labelVariants = cva(
  "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
);

function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & VariantProps<typeof labelVariants>) {
  // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor passed via spread props
  return <label className={cn(labelVariants(), className)} {...props} />;
}

export { Label };
