import { randomUUID } from "node:crypto";

export function createSttRequestId() {
  return `stt_${randomUUID().replaceAll("-", "")}`;
}
