import { formatDate } from "./lib/utils";

export async function query(sql: string): Promise<unknown[]> {
  console.log(`[${formatDate(new Date())}] ${sql}`);
  return [];
}
