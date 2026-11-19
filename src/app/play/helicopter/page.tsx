import { PlaygroundPage } from "@/components/playground/PlaygroundPage";
import { gameMetadata } from "@/content";

export const metadata = gameMetadata("helicopter");

export default function Page() {
  return <PlaygroundPage vehicle="helicopter" />;
}
