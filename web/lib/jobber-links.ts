// Links back into Jobber from encoded Jobber IDs ("gid://Jobber/Job/123" in base64).
function numericId(encoded: string | null | undefined, kind: string): string | null {
  if (!encoded) return null;
  try {
    const m = atob(encoded).match(new RegExp(`/${kind}/(\\d+)$`));
    return m ? m[1] : null;
  } catch { return null; }
}
export const jobberJobUrl = (id: string | null | undefined) => {
  const n = numericId(id, "Job"); return n ? `https://secure.getjobber.com/work_orders/${n}` : null;
};
export const jobberClientUrl = (id: string | null | undefined) => {
  const n = numericId(id, "Client"); return n ? `https://secure.getjobber.com/clients/${n}` : null;
};
