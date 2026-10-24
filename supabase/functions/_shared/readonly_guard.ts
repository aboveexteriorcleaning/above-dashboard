// Second lock on top of Jobber's read-only scopes: this code can only ever
// send GraphQL *queries*. Any document that contains a mutation or
// subscription is refused before it leaves the server.

export class ReadOnlyViolation extends Error {}

export function assertReadOnly(document: string): void {
  // Strip comments and string literals so they can't hide or fake keywords.
  const stripped = document
    .replace(/#[^\n]*/g, " ")
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');

  if (/\b(mutation|subscription)\b/i.test(stripped)) {
    throw new ReadOnlyViolation("Blocked: only read queries may be sent to Jobber.");
  }
  // Every operation must be an explicit `query` or an anonymous selection set.
  const trimmed = stripped.trim();
  if (!(trimmed.startsWith("query") || trimmed.startsWith("{"))) {
    throw new ReadOnlyViolation("Blocked: document is not a read query.");
  }
}
