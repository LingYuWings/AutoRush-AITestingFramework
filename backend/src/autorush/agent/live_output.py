"""Collect live model activity and archive sanitized transcripts for local review."""
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
import json
import re

from autorush.api_testing.variables import SENSITIVE, redact


MAX_EVENTS = 80
MAX_ARCHIVE_EVENTS = 800
MAX_TEXT = 6_000
_OUTPUT_FIELD = re.compile(r'("(?:\\.|[^"\\])*")\s*:|\b([\w-]+)\s*[:=]')


# Preserve clean reply text and mask credential fields even while JSON is incomplete.
def _display_output(text, secrets):
    body = text.strip()
    if body.startswith('```') and body.endswith('```') and '\n' in body:
        body = body.split('\n', 1)[1][:-3].strip()
    try:
        parsed = json.loads(body)
    except (ValueError, RecursionError):
        # Until a sensitive value can be parsed safely, withhold the following text.
        for match in _OUTPUT_FIELD.finditer(text):
            key = match[2]
            if key is None:
                try:
                    key = json.loads(match[1])
                except ValueError:
                    key = match[1]
            if SENSITIVE.search(key):
                return text[:match.end()] + ' [redacted]'
    else:
        try:
            sanitized = redact(parsed, secrets)
        except RecursionError:
            return '[redacted]'
        if sanitized != parsed:
            replacement = json.dumps(sanitized, ensure_ascii=False, indent=2)
            return text.replace(body, replacement, 1)
    return text


# Collect ordered messages separately from reports and checkpoints.
class LiveOutput:
    # Initialize the bounded transcript and its current case and step.
    def __init__(self, limit=MAX_EVENTS):
        self.events = deque(maxlen=limit)
        self.sequence = 0
        self.case = None
        self.step = None
        self.secrets = set()

    # Add an event, merging interleaved provider fragments within one request.
    def publish(self, kind, text, *, append=False):
        if append:
            for previous in reversed(self.events):
                if previous['kind'] == 'model' or (previous['case'], previous['step']) != (self.case, self.step):
                    break
                if previous['kind'] == kind and previous['streamed']:
                    combined = previous['text'] + text
                    previous['text'] = combined[:MAX_TEXT]
                    previous['clipped'] |= len(combined) > MAX_TEXT
                    return
        self.sequence += 1
        self.events.append({'id': self.sequence, 'kind': kind, 'text': text[:MAX_TEXT],
                            'case': self.case, 'step': self.step, 'at': datetime.now(timezone.utc).isoformat(),
                            'streamed': append, 'clipped': len(text) > MAX_TEXT})

    # Redact known credentials, including any still-incomplete suffix of a streamed token.
    def snapshot(self, limit=None):
        result = []
        events = list(self.events)
        encoded_secrets = self.secrets | {json.dumps(secret, ensure_ascii=ascii_only)[1:-1]
                                         for secret in self.secrets for ascii_only in (False, True)}
        for event in events if limit is None else events[-limit:]:
            secrets = encoded_secrets if event['kind'] == 'output' else self.secrets
            if event['kind'] == 'output':
                text = _display_output(event['text'], secrets)
                for secret in sorted(filter(None, secrets), key=len, reverse=True):
                    text = text.replace(secret, '[redacted]')
            else:
                text = redact(event['text'], secrets)
            if event['streamed']:
                overlap = max((next((length for length in range(min(len(secret) - 1, len(text)), 0, -1)
                                     if text.endswith(secret[:length])), 0)
                               for secret in secrets if secret and secret[0] in text), default=0)
                if overlap:
                    text = text[:-overlap] + '[redacted]'
            text = text.encode('utf-8', errors='replace').decode('utf-8')
            public = {key: value for key, value in event.items() if key != 'streamed'}
            public['clipped'] |= len(text) > MAX_TEXT
            if event['kind'] == 'reasoning':
                public['source'] = 'provider' if event['streamed'] else 'decision'
            result.append({**public, 'text': text[:MAX_TEXT]})
        return result


# Persist completed transcripts in a separate encrypted table, keyed by execution type.
class ModelOutputStore:
    # Reuse the local vault key while keeping transcripts out of API resource listings.
    def __init__(self, vault):
        self.vault = vault
        with closing(vault.connect()) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS model_output (scope TEXT NOT NULL, execution_id TEXT NOT NULL, '
                       'payload TEXT NOT NULL, PRIMARY KEY(scope, execution_id))')

    # Store an already-sanitized snapshot without changing the saved test outcome.
    def save(self, scope, execution_id, entries):
        with closing(self.vault.connect()) as db, db:
            db.execute('INSERT INTO model_output(scope, execution_id, payload) VALUES(?,?,?) '
                       'ON CONFLICT(scope, execution_id) DO UPDATE SET payload=excluded.payload',
                       (scope, str(execution_id), self.vault.encode(entries)))

    # Decrypt a single transcript on demand.
    def get(self, scope, execution_id):
        with closing(self.vault.connect()) as db:
            row = db.execute('SELECT payload FROM model_output WHERE scope=? AND execution_id=?',
                             (scope, str(execution_id))).fetchone()
        return self.vault.decode(row[0]) if row else None


# Recover only saved decision summaries and outcomes from older reports.
def restore_trace_output(cases, secrets):
    output = LiveOutput(MAX_ARCHIVE_EVENTS)
    output.secrets.update(secrets)
    for index, case in enumerate(cases, 1):
        output.case = index
        for step in case.steps:
            output.step = step.order
            agent = step.evidence.get('agent')
            if not isinstance(agent, dict):
                continue
            for trace in agent.get('traces') or []:
                if not isinstance(trace, dict):
                    continue
                reason = trace.get('brief_reason')
                decision = trace.get('decision')
                operation = trace.get('operation') or (decision.get('operation') if isinstance(decision, dict) else None)
                result = trace.get('result')
                if isinstance(reason, str) and reason:
                    output.publish('reasoning', f'决策依据 · {reason}')
                if isinstance(operation, str) and operation:
                    output.publish('decision', operation)
                if isinstance(result, dict) and result.get('status') in ('passed','failed','blocked','error','skipped'):
                    label = operation if isinstance(operation, str) and operation else 'verify'
                    output.publish('execution', f'{label} · {result["status"]}')
    return [{**event, 'at': None} for event in output.snapshot()]


# Mark a snapshot as partial when earlier entries have rolled out of the buffer.
def output_snapshot(entries, *, active):
    return {'active': active, 'entries': entries, 'truncated': bool(entries and entries[0]['id'] > 1)}
