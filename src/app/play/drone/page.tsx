import { PlaygroundPage } from "@/components/playground/PlaygroundPage";
import { gameMetadata } from "@/content";

export const metadata = gameMetadata("drone");

export default function Page() {
  return <PlaygroundPage vehicle="drone" />;
}
