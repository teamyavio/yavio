import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function BillingTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing</CardTitle>
        <CardDescription>Manage your workspace plan and billing settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">Billing management is coming soon.</p>
      </CardContent>
    </Card>
  );
}
