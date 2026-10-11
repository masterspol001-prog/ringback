import { COLLECTIONS, engine } from "./db.js";
import { listLeads, deleteLead, getBusiness, saveBusiness, listPayments } from "./store.js";
import { saveSettings, recordEvent } from "./domain.js";

export function deleteBusinessAccount(businessId, { confirm } = {}) {
  const id = String(businessId || "").trim();
  if (!id) return { ok: false, error: "businessId_required" };
  if (id === "demo" || id.startsWith("demo-")) return { ok: false, error: "demo_protected" };
  if (confirm !== true && confirm !== "DELETE") return { ok: false, error: "confirm_required" };

  const leads = listLeads(id);
  let leadCount = 0;
  for (const lead of leads) {
    deleteLead(lead.id);
    leadCount += 1;
  }

  let documents = 0;
  for (const collection of COLLECTIONS) {
    const rows = engine.listDocuments(collection, { businessId: id, order: "asc" });
    for (const row of rows) {
      engine.deleteDocument(collection, row.id);
      documents += 1;
    }
  }

  const existing = getBusiness(id);
  if (existing) saveBusiness({ ...existing, deletedAt: new Date().toISOString(), name: "Deleted business" });
  saveSettings(id, { deletedAt: new Date().toISOString(), automationPaused: true, live: false });
  recordEvent({
    businessId: id,
    type: "account_deleted",
    actor: "owner",
    summary: `Account deleted. ${leadCount} leads and ${documents} records removed.`,
  });

  return {
    ok: true,
    businessId: id,
    leadsDeleted: leadCount,
    documentsDeleted: documents,
    note: "Customer conversations, messages, and appointments for this business were deleted. Retention is until export or delete.",
  };
}

export function exportBusinessAccount(businessId) {
  const id = String(businessId || "").trim();
  if (!id) return { ok: false, error: "businessId_required" };
  const documents = {};
  for (const collection of COLLECTIONS) {
    documents[collection] = engine.listDocuments(collection, { businessId: id, order: "asc" });
  }
  return {
    ok: true,
    exportedAt: new Date().toISOString(),
    businessId: id,
    business: getBusiness(id) || null,
    leads: listLeads(id),
    payments: listPayments().filter((p) => p.businessId === id || p.setupId === id),
    documents,
    note: "Export of this business only. Retention is until export or delete.",
  };
}
