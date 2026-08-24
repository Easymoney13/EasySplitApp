import { apiUrl } from './platformTransport';

export async function fetchPaginatedAccountData(
  endpoint: string,
  baseQuery: string,
  responseKey: string,
  maxPages = 10,
): Promise<any[]> {
  const collected: any[] = [];
  let cursor = '';
  const seenCursors = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams(baseQuery);
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(apiUrl(`${endpoint}?${params.toString()}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load account data');
    if (Array.isArray(data[responseKey])) collected.push(...data[responseKey]);
    if (data.nextCursor === null || data.nextCursor === undefined || data.nextCursor === '') break;
    const nextCursor = String(data.nextCursor);
    if (nextCursor === cursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return collected.filter((entry, index, entries) => (
    entry?.id && entries.findIndex((candidate) => candidate?.id === entry.id) === index
  ));
}
