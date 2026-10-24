// Every query the sync is allowed to run. All are reads.
// Field names are verified against Jobber's live schema by `?mode=check`
// before the first real sync (see MANIFEST below).

const PAGE = "pageInfo { hasNextPage endCursor }";

const CLIENT = `id name isCompany createdAt updatedAt
  emails { address primary } phones { number primary }`;

const REQUEST = `id title requestStatus source createdAt updatedAt client { id }`;

const QUOTE = `id quoteNumber quoteStatus createdAt updatedAt sentAt
  client { id } request { id } salesperson { id }
  amounts { subtotal discountAmount total }
  lastTransitioned { approvedAt convertedAt }
  lineItems(first: 30) { nodes { id name quantity unitPrice totalPrice optional } pageInfo { hasNextPage } }`;

const JOB = `id jobNumber title jobStatus jobType createdAt updatedAt startAt completedAt total
  client { id } quote { id }
  property { id address { street1 city postalCode } }
  lineItems(first: 30) { nodes { id name quantity unitPrice totalPrice createdAt } pageInfo { hasNextPage } }
  visits(first: 50) { nodes { id startAt endAt completedAt visitStatus
    assignedUsers(first: 6) { nodes { id } } } pageInfo { hasNextPage } }`;

const INVOICE = `id invoiceNumber invoiceStatus issuedDate dueDate updatedAt
  client { id } jobs(first: 3) { nodes { id } }
  amounts { subtotal total invoiceBalance }`;

// Jobber timesheet entries link to the job, not the individual visit.
const TIMESHEET = `id startAt endAt finalDuration user { id } job { id }`;

export const QUERIES = {
  account: `query { account { id name } }`,
  users: `query Users($first: Int, $after: String) {
    users(first: $first, after: $after) { nodes { id name { full } } ${PAGE} } }`,

  clients: `query Clients($first: Int, $after: String, $since: ISO8601DateTime) {
    clients(first: $first, after: $after, filter: { updatedAt: { after: $since } }) { nodes { ${CLIENT} } ${PAGE} } }`,
  requests: `query Requests($first: Int, $after: String, $since: ISO8601DateTime) {
    requests(first: $first, after: $after, filter: { updatedAt: { after: $since } }) { nodes { ${REQUEST} } ${PAGE} } }`,
  quotes: `query Quotes($first: Int, $after: String, $since: ISO8601DateTime) {
    quotes(first: $first, after: $after, filter: { updatedAt: { after: $since } }) { nodes { ${QUOTE} } ${PAGE} } }`,
  jobs: `query Jobs($first: Int, $after: String, $since: ISO8601DateTime) {
    jobs(first: $first, after: $after, filter: { updatedAt: { after: $since } }) { nodes { ${JOB} } ${PAGE} } }`,
  invoices: `query Invoices($first: Int, $after: String, $since: ISO8601DateTime) {
    invoices(first: $first, after: $after, filter: { updatedAt: { after: $since } }) { nodes { ${INVOICE} } ${PAGE} } }`,
  timesheets: `query Timesheets($first: Int, $after: String, $since: ISO8601DateTime) {
    timeSheetEntries(first: $first, after: $after, filter: { startAt: { after: $since } }) { nodes { ${TIMESHEET} } ${PAGE} } }`,

  // Single records, used by the webhook receiver.
  client:  `query C($id: EncodedId!) { client(id: $id)  { ${CLIENT} } }`,
  request: `query R($id: EncodedId!) { request(id: $id) { ${REQUEST} } }`,
  quote:   `query Q($id: EncodedId!) { quote(id: $id)   { ${QUOTE} } }`,
  job:     `query J($id: EncodedId!) { job(id: $id)     { ${JOB} } }`,
  invoice: `query I($id: EncodedId!) { invoice(id: $id) { ${INVOICE} } }`,
  visit:   `query V($id: EncodedId!) { visit(id: $id)   { id job { id } } }`,
} as const;

export type QueryName = keyof typeof QUERIES;

// Starting page size per list. Jobber caps the "cost" of a single request, and
// records with nested lists (quotes, jobs) cost far more per row. If Jobber still
// says a request is too big, the client halves the page size automatically.
export const PAGE_SIZE: Partial<Record<QueryName, number>> = {
  users: 50, clients: 50, requests: 50, quotes: 15, jobs: 5, invoices: 25, timesheets: 50,
};

// What the schema check verifies: type -> fields we select on it.
export const MANIFEST: Record<string, string[]> = {
  Query: ["account", "users", "clients", "requests", "quotes", "jobs", "invoices",
          "timeSheetEntries", "client", "request", "quote", "job", "invoice", "visit"],
  Client: ["id", "name", "isCompany", "createdAt", "updatedAt", "emails", "phones"],
  Request: ["id", "title", "requestStatus", "source", "createdAt", "updatedAt", "client"],
  Quote: ["id", "quoteNumber", "quoteStatus", "createdAt", "updatedAt", "sentAt", "client",
          "request", "salesperson", "amounts", "lastTransitioned", "lineItems"],
  QuoteLineItem: ["id", "name", "quantity", "unitPrice", "totalPrice", "optional"],
  Job: ["id", "jobNumber", "title", "jobStatus", "jobType", "createdAt", "updatedAt", "startAt",
        "completedAt", "total", "client", "quote", "property", "lineItems", "visits"],
  JobLineItem: ["id", "name", "quantity", "unitPrice", "totalPrice", "createdAt"],
  Visit: ["id", "startAt", "endAt", "completedAt", "visitStatus", "assignedUsers", "job"],
  Invoice: ["id", "invoiceNumber", "invoiceStatus", "issuedDate", "dueDate", "updatedAt",
            "client", "jobs", "amounts"],
  TimeSheetEntry: ["id", "startAt", "endAt", "finalDuration", "user", "job"],
  User: ["id", "name"],
};

// Root fields whose `filter` must accept these keys.
export const FILTERS: Record<string, string[]> = {
  clients: ["updatedAt"], requests: ["updatedAt"], quotes: ["updatedAt"],
  jobs: ["updatedAt"], invoices: ["updatedAt"], timeSheetEntries: ["startAt"],
};
