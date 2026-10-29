import type { PostgresClient } from "reylo";
import { listContacts, contactsWithEmail, selectContactField } from "./reusable-queries.sqlts";

// Hover the calls for SQL, and the variables below for their actual inferred types.
export async function inspectReusableTypes(db: PostgresClient, orgId: number, flag: boolean) {
  const contacts = await listContacts(orgId, true).run(db);
  const allContacts = await listContacts(orgId).run(db);
  const conditional = await listContacts(orgId, flag).run(db);
  const preset = await contactsWithEmail(orgId).run(db);
  const ids = await selectContactField(orgId, "id").run(db);

  const email = contacts[0]?.email; // string | undefined
  const optionalEmail = allContacts[0]?.email; // string | null | undefined
  const conditionalEmail = conditional[0]?.email; // string | null | undefined
  const presetEmail = preset[0]?.email; // string | undefined
  const id = ids[0]?.id; // number | undefined; no email field in this projection

  return { contacts, allContacts, email, optionalEmail, conditionalEmail, presetEmail, id };
}

if (import.meta.main) {
  const { default: postgres } = await import("postgres");
  const db = postgres(process.env.DATABASE_URL!);
  try {
    const result = await inspectReusableTypes(db, 10, true);
    console.log("Imported predicate through a forwarding wrapper:");
    console.table(result.contacts);
    console.log("Omitted flag keeps nullable email:");
    console.table(result.allContacts);
  } finally {
    await db.end();
  }
}
