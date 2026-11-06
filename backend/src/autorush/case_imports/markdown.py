"""Parse the documented Markdown subset using block tokens and line maps."""
import re

from markdown_it import MarkdownIt

from .mapping import CASE_PREFIX, api_block, build_candidate, diagnostic
from .models import ImportParseError, ImportSource

SECTIONS = {'说明', '前置条件', '步骤', '后置步骤'}
HEADERS = {'序号': 'order', '操作': 'intent', '预期结果': 'expected',
           '执行端': 'platform', '始终执行': 'always_run'}
LABEL = re.compile(r'^(执行端|说明)\s*[:：]\s*(.*)$')


def parse_markdown(text, options, limits, digest):
    tokens = MarkdownIt('commonmark', {'html': False, 'maxNesting': 256}).enable('table').parse(text)
    if len(tokens) > limits.max_nodes:
        raise ImportParseError('tree_limit', 'Markdown 内容节点超过限制。')
    if any(token.level > limits.max_depth for token in tokens):
        raise ImportParseError('tree_limit', 'Markdown 嵌套深度超过限制。')
    lines = text.splitlines()
    headings = [(i, int(t.tag[1:]), tokens[i + 1].content) for i, t in enumerate(tokens)
                if t.type == 'heading_open' and t.level == 0]
    candidates = []
    ancestors = {}
    for heading_index, (start, level, heading) in enumerate(headings):
        ancestors = {key: value for key, value in ancestors.items() if key < level}
        match = CASE_PREFIX.fullmatch(heading)
        if level != options.case_heading_level or match is None:
            ancestors[level] = heading
            continue
        if len(candidates) >= limits.max_cases:
            raise ImportParseError('case_limit', '候选用例数量超过限制。')
        end = next((i for i, depth, _ in headings[heading_index + 1:] if depth <= level), len(tokens))
        title = match.group(1).strip()
        line_end = tokens[end].map[0] if end < len(tokens) else len(lines)
        source = ImportSource(line_start=tokens[start].map[0] + 1, line_end=line_end,
                              topic_path=[*ancestors.values(), title])
        issues = []
        platform_value = None
        descriptions = []
        section_indexes = [(i, name) for i, depth, name in headings if start < i < end and depth == level + 1]
        metadata_end = section_indexes[0][0] if section_indexes else end
        metadata = tokens[start + 3:metadata_end]
        for token in metadata:
            if token.type != 'inline':
                continue
            found = LABEL.fullmatch(token.content.strip())
            if found and found.group(1) == '执行端':
                if platform_value is not None:
                    issues.append(diagnostic('duplicate_platform', '用例执行端不能重复声明。', source=source))
                platform_value = found.group(2)
            elif found:
                descriptions.append(found.group(2))
            elif token.content.strip():
                descriptions.append(token.content)
                issues.append(diagnostic('metadata_preserved', '未识别的用例元数据已保留在说明中。', source=source, warning=True))
        rows, post_rows = [], []
        requests, post_requests = {}, {}
        seen_sections = set()
        for position, (section_start, name) in enumerate(section_indexes):
            section_end = section_indexes[position + 1][0] if position + 1 < len(section_indexes) else end
            section = tokens[section_start + 3:section_end]
            if name not in SECTIONS:
                issues.append(diagnostic('unknown_section', '未识别的小节不会转成步骤，请调整小节映射。', source=source))
                continue
            if name in seen_sections:
                issues.append(diagnostic('duplicate_section', '同一用例不能重复声明相同小节。', source=source))
            seen_sections.add(name)
            if name in {'说明', '前置条件'}:
                first = tokens[section_start].map[1]
                last = tokens[section_end].map[0] if section_end < len(tokens) else len(lines)
                raw = '\n'.join(lines[first:last]).strip()
                if raw:
                    descriptions.append(('前置条件\n' if name == '前置条件' else '') + raw)
                continue
            found_rows, found_requests = parse_step_section(section, issues, source, lines)
            if name == '步骤':
                rows.extend(found_rows)
                requests.update(found_requests)
            else:
                post_rows.extend(found_rows)
                post_requests.update(found_requests)
        candidates.append(build_candidate(title=title, platform_value=platform_value,
                          description='\n\n'.join(descriptions), rows=rows, post_rows=post_rows,
                          api_requests=requests, post_api_requests=post_requests, source=source,
                          identity=f'{digest}:line:{source.line_start}', options=options, issues=issues))
    return candidates, []


def parse_step_section(tokens, issues, source, lines):
    rows, requests = [], {}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token.type == 'table_open' and token.level == 0:
            end = next(i for i in range(index + 1, len(tokens)) if tokens[i].type == 'table_close')
            table_rows(tokens[index:end + 1], rows, issues, source, lines)
            index = end + 1
        elif token.type == 'ordered_list_open' and token.level == 0:
            end = next(i for i in range(index + 1, len(tokens))
                       if tokens[i].type == 'ordered_list_close' and tokens[i].level == 0)
            list_rows(tokens[index:end + 1], rows, issues, source, lines)
            index = end + 1
        elif token.type == 'fence':
            if token.info.strip() == 'autorush-api':
                block_source = source.model_copy(update={'line_start': token.map[0] + 1, 'line_end': token.map[1]})
                parsed = api_block(token.content, issues, block_source)
                if parsed:
                    order, request = parsed
                    if order in requests:
                        issues.append(diagnostic('duplicate_api_request', '同一步骤不能重复定义 API 请求。', source=block_source))
                    requests[order] = request
            else:
                issues.append(diagnostic('unsupported_step_block', '步骤中的代码块仅支持 autorush-api。', source=source))
            index += 1
        else:
            if token.type in {'inline', 'code_block'}:
                issues.append(diagnostic('unsupported_step_block', '步骤须使用标准表格或操作／预期有序列表。', source=source))
            index += 1
    return rows, requests


def table_rows(tokens, rows, issues, source, lines):
    headers = []
    cells = []
    row_source = source
    for token in tokens:
        if token.type == 'tr_open':
            cells = []
            if token.map:
                row_source = source.model_copy(update={'line_start': token.map[0] + 1, 'line_end': token.map[1]})
        elif token.type == 'inline':
            # Tables unescape pipes while retaining other literal inline syntax.
            cells.append(token.content)
        elif token.type == 'tr_close':
            if not headers:
                headers = [HEADERS.get(value.strip(), '') for value in cells]
                if (not {'order', 'intent', 'expected'}.issubset(headers) or '' in headers
                        or len(set(headers)) != len(headers)):
                    issues.append(diagnostic('table_columns', '表格须含唯一的序号、操作、预期结果列，可选执行端和始终执行。', source=row_source))
            else:
                # The Markdown table extension pads or discards cells. Check the
                # physical row as well so extra user content cannot disappear.
                if token.map is not None:
                    raw = lines[token.map[0]].strip()
                else:
                    raw = lines[row_source.line_start - 1].strip()
                separators, backslashes = [], 0
                for position, char in enumerate(raw):
                    if char == '|' and backslashes % 2 == 0:
                        separators.append(position)
                    backslashes = backslashes + 1 if char == '\\' else 0
                column_count = len(separators) + 1
                if separators and separators[0] == 0:
                    column_count -= 1
                if separators and separators[-1] == len(raw) - 1:
                    column_count -= 1
                if column_count != len(headers):
                    issues.append(diagnostic('table_columns', '表格数据行的列数必须与表头一致。', source=row_source))
                row = dict(zip(headers, cells))
                row['source'] = row_source
                rows.append(row)


def list_rows(tokens, rows, issues, source, lines):
    for index, token in enumerate(tokens):
        if token.type != 'list_item_open' or token.level != 1:
            continue
        end = next(i for i in range(index + 1, len(tokens))
                   if tokens[i].type == 'list_item_close' and tokens[i].level == 1)
        row_source = source.model_copy(update={'line_start': token.map[0] + 1, 'line_end': token.map[1]})
        original = re.match(r'\s*(\d+)[.)]\s', lines[token.map[0]])
        row = {'order': original.group(1) if original else '', 'source': row_source}
        if any(t.type in {'fence', 'code_block', 'bullet_list_open', 'ordered_list_open',
                          'blockquote_open', 'heading_open', 'html_block'}
               for t in tokens[index + 1:end]):
            issues.append(diagnostic('unsupported_step_block', '列表步骤中不能嵌入代码块、子列表或其他结构。', source=row_source))
        content = [t.content for t in tokens[index + 1:end] if t.type == 'inline']
        for line in '\n'.join(content).splitlines():
            found = re.fullmatch(r'\s*(操作|预期|预期结果|执行端|始终执行)\s*[:：]\s*(.*)', line)
            if found:
                key = {'预期': 'expected', **HEADERS}[found.group(1)]
                if key in row:
                    issues.append(diagnostic('duplicate_step_field', '一个步骤不能重复定义同一字段。', source=row_source))
                row[key] = found.group(2)
            else:
                issues.append(diagnostic('invalid_step_list', '列表步骤每行须明确标注操作、预期等字段。', source=row_source))
        rows.append(row)
