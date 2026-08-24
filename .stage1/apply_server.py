from pathlib import Path

patch_path = Path('.stage1/05-server.patch')
server_path = Path('server.js')
patch_lines = patch_path.read_text(encoding='utf-8').splitlines(keepends=True)
text = server_path.read_text(encoding='utf-8')

hunks = []
index = 0
while index < len(patch_lines):
    if not patch_lines[index].startswith('@@ '):
        index += 1
        continue
    index += 1
    before = []
    after = []
    while index < len(patch_lines) and not patch_lines[index].startswith('@@ ') and not patch_lines[index].startswith('diff --git '):
        line = patch_lines[index]
        if line.startswith(' '):
            before.append(line[1:])
            after.append(line[1:])
        elif line.startswith('-') and not line.startswith('---'):
            before.append(line[1:])
        elif line.startswith('+') and not line.startswith('+++'):
            after.append(line[1:])
        index += 1
    hunks.append((''.join(before), ''.join(after)))

for hunk_number, (before, after) in enumerate(hunks, 1):
    matches = text.count(before)
    if matches != 1:
        raise SystemExit(f'server patch hunk {hunk_number} expected exactly one match, found {matches}')
    text = text.replace(before, after, 1)

server_path.write_text(text, encoding='utf-8')
print(f'Applied {len(hunks)} server.js hunks cleanly')
