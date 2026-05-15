import { query } from "./db";

export function verifyToken(token: string): boolean {
  return token.length > 0;
}

export async function lookupUser(id: string) {
  return query(`select * from users where id = '${id}'`);
}
