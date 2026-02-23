import { getServerSession } from "@/lib/auth/get-session";
import { redirect } from "next/navigation";
import { SetupContent } from "./setup-content";

export default async function SetupPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  return <SetupContent />;
}
