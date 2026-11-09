"""Keep recent execution activity in memory for the local operator."""
from collections import deque
from datetime import datetime, timezone

from autorush.api_testing.variables import redact


MAX_EVENTS = 80
MAX_TEXT = 6_000


# Store ordered messages without persisting model output in reports or checkpoints.
class LiveOutput:
    # Initialize the bounded transcript and its current case and step.
    def __init__(self):
        self.events = deque(maxlen=MAX_EVENTS)
        self.sequence = 0
        self.case = None
        self.step = None
        self.secrets = set()

    # Add an event, coalescing consecutive deltas from a single reasoning response.
    def publish(self, kind, text, *, append=False):
        previous = self.events[-1] if self.events else None
        if append and previous and previous['kind'] == kind and (previous['case'], previous['step']) == (self.case, self.step):
            previous['text'] = (previous['text'] + text)[:MAX_TEXT]
            return
        self.sequence += 1
        self.events.append({'id': self.sequence, 'kind': kind, 'text': text[:MAX_TEXT],
                            'case': self.case, 'step': self.step, 'at': datetime.now(timezone.utc).isoformat(),
                            'streamed': append})

    # Redact known credentials, including any still-incomplete suffix of a streamed token.
    def snapshot(self):
        result = []
        for event in self.events:
            text = redact(event['text'], self.secrets)
            if event['streamed']:
                overlap = max((next((length for length in range(min(len(secret) - 1, len(text)), 0, -1)
                                     if text.endswith(secret[:length])), 0)
                               for secret in self.secrets if secret and secret[0] in text), default=0)
                if overlap:
                    text = text[:-overlap] + '[redacted]'
            text = text.encode('utf-8', errors='replace').decode('utf-8')
            public = {key: value for key, value in event.items() if key != 'streamed'}
            if event['kind'] == 'reasoning':
                public['source'] = 'provider' if event['streamed'] else 'decision'
            result.append({**public, 'text': text[:MAX_TEXT]})
        return result
