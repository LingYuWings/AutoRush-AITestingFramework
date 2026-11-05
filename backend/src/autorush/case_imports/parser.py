"""Public parsing entry point; no storage, model, driver, or network calls."""
import hashlib
from pathlib import PureWindowsPath

from .models import ImportLimits, ImportOptions, ImportParseError, ImportPreview
from .mapping import diagnostic


def parse_import(content: bytes, filename: str, options: ImportOptions | None = None,
                 *, limits: ImportLimits | None = None) -> ImportPreview:
    limits = limits or ImportLimits()
    options = options or ImportOptions()
    if len(content) > limits.max_file_bytes:
        raise ImportParseError('file_limit', '文件超过上传大小限制。')
    filename = PureWindowsPath(filename).name
    extension = PureWindowsPath(filename).suffix.casefold()
    digest = hashlib.sha256(content).hexdigest()
    if extension in {'.md', '.markdown'}:
        from .markdown import parse_markdown
        try:
            text = content.decode('utf-8-sig')
        except UnicodeDecodeError:
            raise ImportParseError('invalid_encoding', 'Markdown 必须使用 UTF-8 编码。') from None
        if '\x00' in text:
            raise ImportParseError('invalid_encoding', '文件包含无效的 NUL 字符。')
        candidates, issues = parse_markdown(text, options, limits, digest)
        format_name = 'markdown'
    elif extension == '.xmind':
        from .xmind import parse_xmind
        candidates, issues, format_name = parse_xmind(content, options, limits, digest)
    else:
        raise ImportParseError('unsupported_format', '仅支持 .md、.markdown 和 .xmind 文件。')
    if len(candidates) > limits.max_cases:
        raise ImportParseError('case_limit', '候选用例数量超过限制。')
    by_title = {}
    for candidate in candidates:
        by_title.setdefault(candidate.draft['title'].casefold(), []).append(candidate)
    for group in by_title.values():
        if len(group) > 1:
            for candidate in group:
                candidate.diagnostics.append(diagnostic('duplicate_title', '存在同名候选，将分别创建草稿，不会覆盖。', source=candidate.source, warning=True))
    if not candidates:
        issues.append(diagnostic('no_cases', '未发现用例，请检查用例标记、层级或工作表选择。', warning=True))
    return ImportPreview(filename=filename, file_sha256=digest, format=format_name,
                         candidates=candidates, diagnostics=issues)
