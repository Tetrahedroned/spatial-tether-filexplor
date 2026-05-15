import { clamp } from "@/lib/utils";

export function runFeature(): number {
  return clamp(42, 0, 100);
}
