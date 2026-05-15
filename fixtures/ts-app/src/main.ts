import { verifyToken } from "./auth";
import { query } from "./db";
import { formatDate } from "./lib/utils";

export async function handleRequest(token: string) {
  if (!verifyToken(token)) return null;
  const rows = await query("select 1");
  return { rows, when: formatDate(new Date()) };
}

export async function lazyFeature() {
  const mod = await import("./feature");
  return mod.runFeature();
}
