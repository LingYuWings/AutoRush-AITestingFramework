"""Bounded data-only CSV/JSON iteration inputs, preserving JSON value types."""
import csv
import io
import json
import re

from autorush.api_testing.variables import redact

KEY = re.compile(r'^[A-Za-z_][A-Za-z0-9_.-]*$')


def parse_dataset(format, content):
    if not isinstance(content, str) or len(content.encode('utf-8')) > 1048576:
        raise ValueError('dataset must be UTF-8 text no larger than 1 MiB')
    content = content.removeprefix('\ufeff')
    if '\x00' in content or '\ufffd' in content: raise ValueError('dataset encoding is not supported; use UTF-8')
    if format == 'json':
        try: rows = json.loads(content)
        except (ValueError, RecursionError): raise ValueError('dataset must be a valid JSON array of objects') from None
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError('JSON dataset requires an array of objects')
    elif format == 'csv':
        csv.field_size_limit(1048576)
        reader = csv.reader(io.StringIO(content, newline=''), strict=True)
        try:
            headers = next(reader, [])
            if len(headers) != len(set(headers)): raise ValueError('CSV headers must be unique')
            if not headers or any(not KEY.fullmatch(key) for key in headers):
                raise ValueError('CSV headers must be nonempty valid variable names')
            if len(headers) > 100: raise ValueError('dataset supports at most 100 columns')
            rows = []
            for values in reader:
                if not values: continue
                if len(values) != len(headers): raise ValueError(f'CSV line {reader.line_num} has an inconsistent number of columns')
                rows.append(dict(zip(headers, values)))
                if len(rows) > 1000: raise ValueError('dataset supports at most 1000 rows')
        except csv.Error as exc: raise ValueError(f'invalid CSV near line {reader.line_num}') from exc
    else: raise ValueError('dataset format must be csv or json')
    if not rows or len(rows) > 1000: raise ValueError('dataset requires 1..1000 rows')
    columns = list(dict.fromkeys(key for row in rows for key in row))
    if not columns or len(columns) > 100 or any(not KEY.fullmatch(key) for key in columns):
        raise ValueError('dataset requires 1..100 columns with valid variable names')
    return rows


def dataset_preview(format, content):
    rows = parse_dataset(format, content)
    return {'row_count': len(rows), 'columns': list(dict.fromkeys(key for row in rows for key in row)),
        'preview': redact(rows[:10]), 'preview_truncated': len(rows) > 10}
