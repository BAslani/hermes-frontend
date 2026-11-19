import { PlaygroundPage } from "@/components/playground/PlaygroundPage";
import { gameMetadata } from "@/content";

export const metadata = gameMetadata("airplane");

export default function Page() {
  return <PlaygroundPage vehicle="airplane" />;
}
