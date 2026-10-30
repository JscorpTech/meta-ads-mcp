import { createHash } from "node:crypto";
import { z } from "zod";

export const audienceUsersInput = z.object({
  account_id: z.string(),
  audience_id: z.string(),
  users: z.array(z.object({
    email: z.string().max(320).optional(),
    phone: z.string().max(100).optional(),
  }).strict()).min(1).max(10000),
  pre_hashed: z.boolean().default(false),
  dry_run: z.boolean().default(true),
});

export function prepareAudienceUsers(input: z.input<typeof audienceUsersInput>) {
  const parsed = audienceUsersInput.safeParse(input);
  if (!parsed.success) throw new Error("Invalid audience upload: provide 1–10000 email/phone records and valid options.");
  const { users, pre_hashed } = parsed.data;
  const data: string[][] = [];
  const seen = new Set<string>();
  for (const [index, user] of users.entries()) {
    const values = [user.email?.trim() ?? "", user.phone?.trim() ?? ""];
    if (!values.some(Boolean)) throw new Error(`Row ${index + 1}: email or phone is required.`);
    const row = values.map((value, column) => {
      if (!value) return "";
      if (pre_hashed) {
        if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`Row ${index + 1}: expected a SHA-256 hex digest.`);
        return value.toLowerCase();
      }
      let normalized: string;
      if (column === 0) {
        normalized = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error(`Row ${index + 1}: invalid email.`);
      } else {
        if (!/^\+?[\d\s().-]+$/.test(value)) throw new Error(`Row ${index + 1}: invalid phone.`);
        normalized = value.replace(/\D/g, "").replace(/^00/, "");
        if (!/^[1-9]\d{6,14}$/.test(normalized)) throw new Error(`Row ${index + 1}: phone must include its country code.`);
      }
      return createHash("sha256").update(normalized, "utf8").digest("hex");
    });
    const key = row.join(":");
    if (!seen.has(key)) { seen.add(key); data.push(row); }
  }
  return { ...parsed.data, payload: { schema: ["EMAIL", "PHONE"], data }, duplicates: users.length - data.length };
}
