"""Export the Maya vault to portable GitHub docs without changing source notes.

Usage: python tooling/export-obsidian-docs.py --vault /path/to/Maya
Only local files are read. Raw attachment bytes and frozen review hashes remain intact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
from urllib.parse import quote, unquote


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vault', type=Path, required=True)
    args = parser.parse_args()
    vault = args.vault.resolve()
    repo = Path(__file__).resolve().parents[1]
    output = repo / 'docs' / 'obsidian'
    output.mkdir(parents=True, exist_ok=True)
    notes = sorted(vault.glob('*.md'))
    canvases = sorted(vault.glob('*.canvas'))
    runtime_manifest = vault / 'Attachments/Maya Runtime/runtime-evidence-manifest.json'
    runtime = json.loads(runtime_manifest.read_text(encoding='utf-8-sig'))
    mapped = {(vault / row['archive']).resolve(): repo / row['source'] for row in runtime['files']}
    attachments = sorted(p for p in (vault / 'Attachments').rglob('*')
                         if p.is_file() and '__pycache__' not in p.parts
                         and 'Maya Runtime' not in p.relative_to(vault).parts)
    mapping = {p.resolve(): output / p.relative_to(vault) for p in notes + canvases + attachments}
    mapping.update(mapped)
    mapping[runtime_manifest.resolve()] = output / 'runtime-evidence-manifest.json'
    errors = []
    converted = 0
    local_links = []
    external_local_references = []

    def resolve(target: str, source: Path, wiki: bool = False) -> tuple[Path | None, str]:
        target = unquote(target.strip('<>'))
        base, sep, anchor = target.partition('#')
        if not base:
            return source, sep + anchor
        if re.match(r'^(?:https?://|mailto:|obsidian:)', base):
            return None, target
        candidates = [source.parent / base, vault / base]
        if wiki:
            candidates = [Path(str(p) + '.md') for p in candidates] + candidates
        for candidate in candidates:
            if candidate.exists():
                return candidate.resolve(), sep + anchor
        errors.append({'note': str(source.relative_to(vault)), 'missingTarget': target})
        return None, target

    def destination(target: str, source: Path, wiki: bool = False) -> str:
        path, suffix = resolve(target, source, wiki)
        if path is None:
            return suffix
        dest = mapping.get(path)
        if dest is None and path.is_relative_to(repo):
            dest = path
        if dest is None:
            errors.append({'note': str(source.relative_to(vault)), 'unexportedTarget': str(path)})
            return target
        if suffix and wiki:
            # Obsidian headings become GitHub's lowercase hyphenated heading anchors.
            suffix = '#' + re.sub(r'[^\w\- ]', '', suffix[1:].lower()).replace(' ', '-')
        rel = Path(os.path.relpath(dest, mapping[source.resolve()].parent)).as_posix()
        local_links.append({'note': mapping[source.resolve()].relative_to(repo).as_posix(),
                            'target': dest.relative_to(repo).as_posix()})
        return quote(rel, safe='/.-_') + suffix

    def transform(content: str, source: Path) -> str:
        nonlocal converted
        # Process ordinary links first so converted wiki links are not handled twice.
        def ordinary_link(match: re.Match) -> str:
            target = unquote(match[2].strip('<>'))
            if re.match(r'^[A-Za-z]:[/\\]', target):
                path = Path(target.split('#')[0]).resolve()
                if not path.is_relative_to(repo) and not path.is_relative_to(vault):
                    external_local_references.append({'note': source.name, 'target': target})
                    return f'{match[1][1:-1]} (historical local reference: `{target}`)'
            return f'{match[1]}({destination(match[2], source)})'

        content = re.sub(r'(?<!!)(\[[^\]\n]+\])\((<[^>]+>|[^)\n]+)\)', ordinary_link, content)

        def wiki_link(match: re.Match) -> str:
            nonlocal converted
            embed, inner = match.groups()
            target, _, alias = inner.partition('|')
            label = alias or target.split('#')[0].rsplit('/', 1)[-1]
            label = label.replace('[', '').replace(']', '')
            link = destination(target, source, wiki=True)
            converted += 1
            # GitHub does not render an MP4 through Markdown image syntax.
            is_image = Path(target.split('#')[0]).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'}
            return f'{"!" if embed and is_image else ""}[{label}]({link})'

        return re.sub(r'(!?)\[\[([^\]\n]+)\]\]', wiki_link, content)

    records = []
    for source in notes + canvases + attachments + [runtime_manifest]:
        dest = mapping[source.resolve()]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if source in notes:
            dest.write_text(transform(source.read_text(encoding='utf-8-sig'), source), encoding='utf-8', newline='\n')
        else:
            shutil.copyfile(source, dest)
        records.append({'source': source.relative_to(vault).as_posix(),
                        'output': dest.relative_to(repo).as_posix(),
                        'sourceSha256': digest(source), 'outputSha256': digest(dest),
                        'bytes': dest.stat().st_size, 'transformed': source in notes})

    groups = {
        'Current delivery and graph': [p for p in notes if p.name.startswith('Maya - ')],
        'Node plans and their review loops': [p for p in notes if p.name.startswith('Maya Development - ')],
        'Runtime QA, debugging and corrections': [p for p in notes if p.name.startswith('Maya Runtime - ')],
        'Product research, evidence and scope': [p for p in notes if not p.name.startswith(('Maya - ', 'Maya Development - ', 'Maya Runtime - '))],
    }
    index = ['# Maya documentation', '',
             '[Start with the planning, debugging and results index](obsidian/Maya%20-%20Planning%20Debug%20and%20Results%20Index.md).', '',
             'The original Obsidian notes are exported below with portable links. Historical plans, failed checks and intermediate builds are retained. The mobile thumb-bar report describes the current phone controls and deployment gauntlet; the wallet/fresh-session report describes session resets. Earlier shared-balance and sampled-settlement rules are superseded.', '',
             '[Architecture and integration README](../README.md) · [Delivery record](DELIVERY.md) · [Wallet/session update](UI-AND-SESSION-UPDATE.md) · [Quantellics brand assets](brand/README.md)', '',
             '[Export manifest](obsidian/export-manifest.json) · [Runtime evidence](../artifacts/verification/)', '']
    for title, paths in groups.items():
        index.extend([f'## {title}', ''])
        index.extend(f'- [{p.stem}](obsidian/{quote(p.name)})' for p in paths)
        index.append('')
    index.extend(['## Evidence and export', '',
                  'Research and development attachments are preserved byte for byte, including the reference video, screenshots, frozen graph inputs, review reports and public-provider snapshots. Raw attachment Markdown remains archival Obsidian text so its recorded SHA-256 stays valid. Runtime links resolve to the existing monorepo artifacts; the exported runtime manifest maps original vault paths to those sources.', '',
                  'The Obsidian Canvas is preserved beside the notes. GitHub renders the Mermaid graphs in the Markdown graph/index; open the `.canvas` file in Obsidian for the spatial view.', '',
                  'To refresh this documentation from the local vault:', '', '```powershell',
                  'python tooling/export-obsidian-docs.py --vault "<path-to-obsidian-vault>"', '```', '',
                  'The exporter reads local files only, verifies local targets and records source/output hashes. It does not execute archived research scripts or fetch vendor code.', ''])
    (repo / 'docs/README.md').write_text('\n'.join(index), encoding='utf-8', newline='\n')
    for item in local_links:
        if not (repo / item['target']).exists():
            errors.append({'missingOutput': item})
    for row in runtime['files']:
        src = repo / row['source']
        if not src.is_file() or digest(src) != row['sha256']:
            errors.append({'runtimeHashMismatch': row['source']})
    report = {'notes': len(notes), 'canvases': len(canvases), 'attachments': len(attachments),
              'convertedWikiLinks': converted, 'localLinksChecked': len(local_links),
              'runtimeReferencesVerified': len(runtime['files']), 'errors': errors,
              'externalLocalReferences': external_local_references,
              'files': records}
    (output / 'export-manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'files'}, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
