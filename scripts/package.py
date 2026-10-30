"""Build an install-only ZIP; never include development fixtures or user data."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))['version']
output = root / 'dist' / f'SillyTavern-HomeChatFolders-v{version}.zip'
output.parent.mkdir(exist_ok=True)
files = [root / name for name in ('manifest.json', 'index.js', 'style.css', 'README.md', 'CHANGELOG.md', 'LICENSE')]
files += sorted((root / 'src').glob('*.js'))
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(file, (Path('SillyTavern-HomeChatFolders') / file.relative_to(root)).as_posix())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert len(archive.namelist()) == len(files)
    for filename in archive.namelist():
        assert filename.startswith('SillyTavern-HomeChatFolders/') and '..' not in Path(filename).parts
print(output)
print(f'{len(files)} files; {output.stat().st_size} bytes; ZIP verified')
