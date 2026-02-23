"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmText?: string;
  confirmLabel?: string;
  actionLabel?: string;
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  confirmLabel,
  actionLabel = "Delete",
  onConfirm,
}: ConfirmDialogProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const confirmed = confirmText ? input === confirmText : true;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setInput("");
      setLoading(false);
    }
    onOpenChange(next);
  }

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
    } finally {
      setLoading(false);
      setInput("");
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {confirmText && (
          <div className="space-y-2">
            <Label htmlFor="confirm-input">
              {confirmLabel ?? `Type "${confirmText}" to confirm`}
            </Label>
            <Input
              id="confirm-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={confirmText}
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!confirmed || loading}
            onClick={(e) => {
              e.preventDefault();
              handleConfirm();
            }}
          >
            {loading ? "Processing..." : actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
