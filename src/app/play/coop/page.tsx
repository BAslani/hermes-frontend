import { CoopPage } from "@/components/coop/CoopPage";
import { gameMetadata } from "@/content";

export const metadata = gameMetadata("coop");

export default function Page() {
  return <CoopPage />;
}
