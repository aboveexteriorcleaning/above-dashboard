// Pure functions: Jobber record -> our table rows. No I/O, easy to test.

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const primary = (xs: any[] | undefined): any =>
  xs?.find((x) => x.primary) ?? xs?.[0];

export function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return d ? `+${d}` : null;
}

export function mapClient(n: any) {
  return {
    id: n.id,
    name: n.name ?? "(no name)",
    email: primary(n.emails)?.address?.toLowerCase() ?? null,
    phone: normalizePhone(primary(n.phones)?.number),
    is_company: !!n.isCompany,
    jobber_created_at: n.createdAt ?? null,
    synced_at: new Date().toISOString(),
  };
}

export function mapRequest(n: any) {
  return {
    id: n.id,
    client_id: n.client?.id ?? null,
    title: n.title ?? null,
    source: n.source?.trim() || null,
    status: n.requestStatus ?? null,
    created_at: n.createdAt,
    synced_at: new Date().toISOString(),
  };
}

export function mapQuote(n: any, employeeIdFor: (jobberUserId: string) => string | null) {
  const quote = {
    id: n.id,
    quote_number: n.quoteNumber != null ? String(n.quoteNumber) : null,
    client_id: n.client?.id ?? null,
    request_id: n.request?.id ?? null,
    salesperson_id: n.salesperson?.id ? employeeIdFor(n.salesperson.id) : null,
    status: n.quoteStatus ?? null,
    subtotal: num(n.amounts?.subtotal),
    discount_amount: num(n.amounts?.discountAmount),
    total: num(n.amounts?.total),
    created_at: n.createdAt,
    sent_at: n.sentAt ?? null,
    approved_at: n.lastTransitioned?.approvedAt ?? null,
    converted_at: n.lastTransitioned?.convertedAt ?? null,
    synced_at: new Date().toISOString(),
  };
  const lines = (n.lineItems?.nodes ?? []).map((li: any, i: number) => ({
    id: li.id,
    quote_id: n.id,
    product_name: li.name ?? "(unnamed)",
    quantity: num(li.quantity),
    unit_price: num(li.unitPrice),
    total_price: num(li.totalPrice),
    is_optional: !!li.optional,
    sort_order: i,
  }));
  // If Jobber had more line items than one request returns, we only have part of the list.
  const linesComplete = !n.lineItems?.pageInfo?.hasNextPage;
  return { quote, lines, linesComplete };
}

export function mapJob(n: any) {
  const lineNodes = n.lineItems?.nodes ?? [];
  // Pre-tax value of the work = sum of line items (Jobber's `total` includes tax).
  const preTax = lineNodes.length
    ? lineNodes.reduce((s: number, li: any) => s + (Number(li.totalPrice) || 0), 0)
    : num(n.total);
  const property = n.property?.id ? {
    id: n.property.id,
    client_id: n.client?.id ?? null,
    street: n.property.address?.street1 ?? null,
    city: n.property.address?.city ?? null,
    postal_code: n.property.address?.postalCode ?? null,
    synced_at: new Date().toISOString(),
  } : null;
  const job = {
    id: n.id,
    job_number: n.jobNumber ?? null,
    client_id: n.client?.id ?? null,
    property_id: n.property?.id ?? null,
    quote_id: n.quote?.id ?? null,
    title: n.title ?? null,
    status: n.jobStatus ?? null,
    job_type: n.jobType ?? null,
    total: preTax === null ? null : Math.round(preTax * 100) / 100,
    created_at: n.createdAt,
    start_at: n.startAt ?? null,
    completed_at: n.completedAt ?? null,
    synced_at: new Date().toISOString(),
  };
  const lines = lineNodes.map((li: any) => ({
    id: li.id,
    job_id: n.id,
    product_name: li.name ?? "(unnamed)",
    quantity: num(li.quantity),
    unit_price: num(li.unitPrice),
    total_price: num(li.totalPrice),
    created_at: li.createdAt ?? null,
  }));
  const visits = (n.visits?.nodes ?? []).map((v: any) => ({
    id: v.id,
    job_id: n.id,
    start_at: v.startAt ?? null,
    end_at: v.endAt ?? null,
    completed_at: v.completedAt ?? null,
    status: v.visitStatus ?? null,
    synced_at: new Date().toISOString(),
  }));
  const assignments = (n.visits?.nodes ?? []).flatMap((v: any) =>
    (v.assignedUsers?.nodes ?? []).map((u: any) => ({ visit_id: v.id, jobber_user_id: u.id })));
  const linesComplete = !n.lineItems?.pageInfo?.hasNextPage;
  const visitsComplete = !n.visits?.pageInfo?.hasNextPage;
  return { job, property, lines, visits, assignments, linesComplete, visitsComplete };
}

export function mapInvoice(n: any) {
  return {
    id: n.id,
    client_id: n.client?.id ?? null,
    job_id: n.jobs?.nodes?.[0]?.id ?? null,
    status: n.invoiceStatus ?? null,
    issued_at: n.issuedDate ?? null,
    due_at: n.dueDate ?? null,
    subtotal: num(n.amounts?.subtotal),
    total: num(n.amounts?.total),
    balance: num(n.amounts?.invoiceBalance),
    synced_at: new Date().toISOString(),
  };
}

export function mapTimesheet(n: any, employeeIdFor: (jobberUserId: string) => string | null) {
  const employee_id = n.user?.id ? employeeIdFor(n.user.id) : null;
  if (!employee_id || !n.startAt) return null;
  let minutes: number | null = null;
  if (n.startAt && n.endAt) minutes = (Date.parse(n.endAt) - Date.parse(n.startAt)) / 60000;
  else if (n.finalDuration != null) minutes = Number(n.finalDuration) / 60; // seconds
  return {
    id: n.id,
    employee_id,
    job_id: n.job?.id ?? null,
    visit_id: n.visit?.id ?? null,
    started_at: n.startAt,
    ended_at: n.endAt ?? null,
    minutes: minutes === null ? null : Math.round(minutes * 100) / 100,
    is_travel: false,
    synced_at: new Date().toISOString(),
  };
}
