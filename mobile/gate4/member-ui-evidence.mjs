export function readRoomMemberEvidence(root, headingText = 'Room Members') {
  const heading = Array.from(root.querySelectorAll('h3'))
    .find((candidate) => candidate.textContent?.trim() === headingText);
  const card = heading?.closest('.photo-card') || null;
  const countText = heading?.parentElement?.querySelector('span')?.textContent?.trim() || '';
  const count = /^\d+$/.test(countText) ? Number(countText) : null;
  const titles = card
    ? Array.from(card.querySelectorAll('[title]'))
      .map((element) => element.getAttribute('title')?.trim() || '')
      .filter(Boolean)
    : [];
  return { count, titles };
}

export function hasRoomMemberEvidence(root, name, expectedCount) {
  const evidence = readRoomMemberEvidence(root);
  return evidence.count === expectedCount
    && evidence.titles.some((title) => title === name || title.startsWith(`${name} `));
}
