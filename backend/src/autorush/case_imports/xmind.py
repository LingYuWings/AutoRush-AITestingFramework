"""Bounded XMind ZIP reader for JSON content and legacy content XML 2.0."""
from dataclasses import dataclass, field
import io
from pathlib import PurePosixPath
import re
import stat
import zipfile
import zlib
from xml.etree.ElementTree import ParseError

from defusedxml import ElementTree
from defusedxml.common import DefusedXmlException

from .mapping import CASE_PREFIX, api_block, build_candidate, diagnostic, strict_json
from .models import ImportParseError, ImportSource

XML_NS = 'urn:xmind:xmap:xmlns:content:2.0'


@dataclass
class Node:
    id: str
    title: str
    note: str = ''
    labels: list[str] = field(default_factory=list)
    children: list['Node'] = field(default_factory=list)


def read_archive(content, limits):
    result = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > limits.max_entries:
                raise ImportParseError('archive_limit', '压缩包条目数超过限制。')
            seen = set()
            for entry in entries:
                name = entry.orig_filename
                parts = name.split('/')
                if (not name or '\x00' in name or '\\' in name or ':' in name
                        or PurePosixPath(name).is_absolute() or '..' in parts or '.' in parts
                        or name.casefold() in seen or entry.flag_bits & 1
                        or stat.S_ISLNK(entry.external_attr >> 16)):
                    raise ImportParseError('unsafe_archive', '压缩包包含不安全、加密或重复条目。')
                seen.add(name.casefold())
                if entry.file_size > limits.max_uncompressed_bytes - total:
                    raise ImportParseError('archive_limit', '压缩包解压内容超过限制。')
                chunks = []
                with archive.open(entry) as stream:
                    while True:
                        chunk = stream.read(min(65536, limits.max_uncompressed_bytes - total + 1))
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > limits.max_uncompressed_bytes:
                            raise ImportParseError('archive_limit', '压缩包解压内容超过限制。')
                        if name in {'content.json', 'content.xml'}:
                            chunks.append(chunk)
                if name in {'content.json', 'content.xml'}:
                    result[name] = b''.join(chunks)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError, zlib.error, OSError):
        raise ImportParseError('invalid_xmind', '无法读取 XMind 压缩包。') from None
    return result


def load_sheets(content, limits, issues):
    files = read_archive(content, limits)
    count = 0

    def count_node(depth):
        nonlocal count
        count += 1
        if count > limits.max_nodes or depth > limits.max_depth:
            raise ImportParseError('tree_limit', 'XMind 节点数量或嵌套深度超过限制。')

    def required_text(value):
        if not isinstance(value, str):
            raise ValueError('expected text')
        return value

    def json_node(value, depth, fallback):
        count_node(depth)
        if not isinstance(value, dict):
            raise ValueError('expected topic')
        children = value.get('children', {})
        if not isinstance(children, dict) or not all(isinstance(group, list) for group in children.values()):
            raise ValueError('expected topic groups')
        if any(group for key, group in children.items() if key != 'attached'):
            issues.append(diagnostic('unsupported_topics', '仅映射附属主题，自由主题或摘要主题未导入。', warning=True))
        notes = value.get('notes', {})
        plain = notes.get('plain', {})
        note = required_text(plain.get('content', ''))
        if notes and not plain:
            issues.append(diagnostic('rich_notes_skipped', '富文本备注未转成操作，请使用纯文本备注。', warning=True))
        labels = value.get('labels', [])
        if not isinstance(labels, list) or any(not isinstance(item, str) for item in labels):
            raise ValueError('expected labels')
        attached_nodes = []
        for key, group in children.items():
            for index, child in enumerate(group):
                parsed_child = json_node(child, depth + 1, f'{fallback}/{key}/{index}')
                if key == 'attached':
                    attached_nodes.append(parsed_child)
        return Node(required_text(value.get('id', fallback)), required_text(value.get('title', '')), note, labels, attached_nodes)

    def xml_node(value, depth, fallback):
        count_node(depth)
        attached = value.find(f'{{{XML_NS}}}children')
        children = []
        if attached is not None:
            for group in attached:
                if group.tag != f'{{{XML_NS}}}topics':
                    raise ValueError('expected topics group')
                is_attached = group.get('type') == 'attached'
                if not is_attached and len(group):
                    issues.append(diagnostic('unsupported_topics', '仅映射附属主题，自由主题或摘要主题未导入。', warning=True))
                for index, child in enumerate(group):
                    if child.tag != f'{{{XML_NS}}}topic':
                        raise ValueError('expected topic')
                    parsed_child = xml_node(child, depth + 1, f'{fallback}/{group.get("type")}/{index}')
                    if is_attached:
                        children.append(parsed_child)
        note = value.findtext(f'{{{XML_NS}}}notes/{{{XML_NS}}}plain', '')
        labels = [item.text or '' for item in value.findall(f'{{{XML_NS}}}labels/{{{XML_NS}}}label')]
        return Node(value.get('id', fallback), value.findtext(f'{{{XML_NS}}}title', ''), note, labels, children)

    try:
        if 'content.json' in files:
            raw = strict_json(files['content.json'].decode('utf-8-sig'))
            if not isinstance(raw, list):
                raise ValueError('expected sheet array')
            sheets = []
            for index, sheet in enumerate(raw):
                if not isinstance(sheet, dict) or 'rootTopic' not in sheet:
                    raise ValueError('expected sheet')
                sid = required_text(sheet.get('id', f'sheet-{index + 1}'))
                sheets.append((sid, required_text(sheet.get('title', '')), json_node(sheet['rootTopic'], 0, sid)))
            format_name = 'xmind_json'
        elif 'content.xml' in files:
            root = ElementTree.fromstring(files['content.xml'], forbid_dtd=True, forbid_entities=True, forbid_external=True)
            if root.tag != f'{{{XML_NS}}}xmap-content' or root.get('version', '2.0') != '2.0':
                raise ValueError('unsupported XML content')
            sheets = [(sheet.get('id', f'sheet-{index + 1}'), sheet.findtext(f'{{{XML_NS}}}title', ''),
                       xml_node(sheet.find(f'{{{XML_NS}}}topic'), 0, f'sheet-{index + 1}'))
                      for index, sheet in enumerate(root.findall(f'{{{XML_NS}}}sheet'))]
            format_name = 'xmind_xml'
        else:
            raise ImportParseError('unsupported_xmind', '未找到根目录 content.json 或 content.xml。')
        if len({sid for sid, _, _ in sheets}) != len(sheets):
            raise ValueError('duplicate sheet IDs')
        return sheets, format_name
    except ImportParseError:
        raise
    except (ValueError, TypeError, AttributeError, KeyError, UnicodeError, RecursionError, ParseError, DefusedXmlException):
        raise ImportParseError('invalid_xmind', 'XMind 内容损坏或结构不受支持。') from None


def parse_xmind(content, options, limits, digest):
    global_issues = []
    sheets, format_name = load_sheets(content, limits, global_issues)
    candidates = []
    for sheet_id, sheet_title, root in sheets:
        if options.sheet_ids is not None and sheet_id not in options.sheet_ids:
            continue
        stack = [(root, [], [], [], 0)]
        while stack:
            node, path, ids, positions, depth = stack.pop()
            match = CASE_PREFIX.fullmatch(node.title)
            title = match.group(1).strip() if match else node.title
            path, ids = [*path, title], [*ids, node.id]
            selected = depth == options.case_depth if options.case_depth is not None else match is not None
            if selected:
                if len(candidates) >= limits.max_cases:
                    raise ImportParseError('case_limit', '候选用例数量超过限制。')
                source = ImportSource(sheet_id=sheet_id, sheet_title=sheet_title, topic_path=path, topic_ids=ids)
                candidates.append(map_case(node, title, source, f'{digest}:{sheet_id}:{positions}', options))
                continue
            stack.extend((child, path, ids, [*positions, index], depth + 1)
                         for index, child in reversed(list(enumerate(node.children))))
    return candidates, global_issues, format_name


def map_case(node, title, source, identity, options):
    issues = []
    chosen = None
    description = [node.note] if node.note else []
    if node.labels:
        description.append('标签：' + '、'.join(node.labels))
    rows, post_rows, requests, post_requests = [], [], {}, {}
    sections = set()

    def unmapped_extra(value, location, *, allow_note=False, allow_children=False):
        if ((value.note and not allow_note) or (value.children and not allow_children) or value.labels):
            issues.append(diagnostic('unmapped_topic_content', '该字段的备注、标签或子主题未映射，请移至说明或显式步骤中。', source=location))

    def description_lines(value, indent=0):
        result = ['  ' * indent + value.title] if value.title else []
        if value.note:
            result.append(value.note)
        if value.labels:
            result.append('标签：' + '、'.join(value.labels))
        for sub in value.children:
            result.extend(description_lines(sub, indent + 1))
        return result

    for child in node.children:
        child_source = source.model_copy(update={'topic_path': [*source.topic_path, child.title],
                                                'topic_ids': [*source.topic_ids, child.id]})
        match = re.fullmatch(r'执行端\s*[:：]\s*(.*)', child.title)
        if match:
            unmapped_extra(child, child_source)
            if chosen is not None:
                issues.append(diagnostic('duplicate_platform', '用例执行端不能重复声明。', source=source))
            chosen = match.group(1)
        elif child.title in {'说明', '前置条件'}:
            lines = [child.note] if child.note else []
            if child.labels:
                lines.append('标签：' + '、'.join(child.labels))
            for sub in child.children:
                lines.extend(description_lines(sub))
            description.append(('前置条件\n' if child.title == '前置条件' else '') + '\n'.join(lines))
        elif child.title in {'步骤', '后置步骤'}:
            unmapped_extra(child, child_source, allow_children=True)
            if child.title in sections:
                issues.append(diagnostic('duplicate_section', '同一用例不能重复声明相同小节。', source=source))
            sections.add(child.title)
            target_rows, target_requests = (rows, requests) if child.title == '步骤' else (post_rows, post_requests)
            for step in child.children:
                step_source = source.model_copy(update={'topic_path': [*source.topic_path, child.title, step.title],
                                                       'topic_ids': [*source.topic_ids, child.id, step.id]})
                unmapped_extra(step, step_source, allow_children=True)
                numbered = re.fullmatch(r'(\d+)[.、]\s*(.*)', step.title)
                if not numbered:
                    issues.append(diagnostic('step_order', '步骤节点须使用“1. 操作内容”编号。', source=step_source))
                row = dict(order=numbered.group(1) if numbered else '', intent=numbered.group(2) if numbered else step.title, source=step_source)
                for detail in step.children:
                    detail_source = step_source.model_copy(update={'topic_path': [*step_source.topic_path, detail.title],
                                                                   'topic_ids': [*step_source.topic_ids, detail.id]})
                    unmapped_extra(detail, detail_source, allow_note=detail.title == '请求 JSON')
                    label = re.fullmatch(r'(预期结果|预期|执行端|始终执行)\s*[:：]\s*(.*)', detail.title)
                    if label:
                        key = {'预期结果': 'expected', '预期': 'expected', '执行端': 'platform', '始终执行': 'always_run'}[label.group(1)]
                        if key in row:
                            issues.append(diagnostic('duplicate_step_field', '步骤字段重复。', source=step_source))
                        row[key] = label.group(2)
                    elif detail.title == '请求 JSON':
                        block = api_block(detail.note, issues, step_source)
                        if block:
                            order, request = block
                            if order in target_requests:
                                issues.append(diagnostic('duplicate_api_request', 'API 请求重复。', source=step_source))
                            target_requests[order] = request
                    else:
                        issues.append(diagnostic('unknown_step_topic', '未识别的步骤子主题，请使用预期、执行端或请求 JSON。', source=step_source))
                target_rows.append(row)
        else:
            issues.append(diagnostic('unknown_case_topic', '未识别的用例子主题，请调整节点映射。', source=source))
    return build_candidate(title=title, platform_value=chosen, description='\n\n'.join(description), rows=rows,
                           post_rows=post_rows, api_requests=requests, post_api_requests=post_requests,
                           source=source, identity=identity, options=options, issues=issues)
