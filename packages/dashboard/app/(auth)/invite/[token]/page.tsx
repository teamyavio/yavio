import { Suspense } from "react";
import { InviteContent } from "./invite-content";

export default function InvitePage() {
  return (
    <Suspense>
      <InviteContent />
    </Suspense>
  );
}
