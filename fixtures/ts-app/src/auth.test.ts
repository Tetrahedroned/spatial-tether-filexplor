import { verifyToken } from "./auth";

export function testVerifyToken() {
  return verifyToken("abc") === true;
}
