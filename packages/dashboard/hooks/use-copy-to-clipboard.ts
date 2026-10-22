"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const COPIED_MS = 1500;

/**
 * Writes text to the clipboard and reports `copied` for a moment so the
 * button can confirm it; a failed write (no permission, insecure context)
 * becomes a toast. The confirmation timer is cleared on unmount so a copy
 * right before closing a dialog cannot set state on a gone component.
 */
export function useCopyToClipboard() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }, []);

  return { copied, copy };
}
