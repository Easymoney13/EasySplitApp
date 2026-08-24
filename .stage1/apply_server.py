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
    hunks.append((before, after))

def changed_core(before_lines, after_lines):
    prefix = 0
    while prefix < len(before_lines) and prefix < len(after_lines) and before_lines[prefix] == after_lines[prefix]:
        prefix += 1
    suffix = 0
    while (
        suffix < len(before_lines) - prefix
        and suffix < len(after_lines) - prefix
        and before_lines[len(before_lines) - 1 - suffix] == after_lines[len(after_lines) - 1 - suffix]
    ):
        suffix += 1
    before_end = len(before_lines) - suffix if suffix else len(before_lines)
    after_end = len(after_lines) - suffix if suffix else len(after_lines)
    return ''.join(before_lines[prefix:before_end]), ''.join(after_lines[prefix:after_end])

for hunk_number, (before_lines, after_lines) in enumerate(hunks, 1):
    before = ''.join(before_lines)
    after = ''.join(after_lines)
    matches = text.count(before)
    if matches == 1:
        text = text.replace(before, after, 1)
        continue

    core_before, core_after = changed_core(before_lines, after_lines)
    core_matches = text.count(core_before) if core_before else 0
    if core_before and core_matches == 1:
        text = text.replace(core_before, core_after, 1)
        continue

    raise SystemExit(
        f'server patch hunk {hunk_number} could not be applied safely: '
        f'full matches={matches}, changed-core matches={core_matches}'
    )

server_path.write_text(text, encoding='utf-8')
print(f'Applied {len(hunks)} server.js hunks cleanly')
