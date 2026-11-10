"""Read bounded model SSE responses and forward provider-visible text."""
import json


MAX_RESPONSE_BYTES = 2_000_000


# Read complete SSE data frames without letting an unterminated frame grow unbounded.
async def _events(response):
    pending = b''
    fields = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise ValueError('model stream exceeds limit')
        lines = (pending + chunk).split(b'\n')
        pending = lines.pop()
        for line in lines:
            line = line.rstrip(b'\r')
            if line.startswith(b'data:'):
                fields.append(line[5:].lstrip(b' '))
            elif not line and fields:
                data = b'\n'.join(fields)
                fields.clear()
                if data == b'[DONE]':
                    return
                event = json.loads(data)
                if not isinstance(event, dict):
                    raise ValueError('invalid model stream event')
                yield event


# Extract provider-visible reasoning from a non-streaming response.
def response_reasoning(body, protocol):
    if not isinstance(body, dict):
        return
    if protocol == 'openai_chat':
        choices = body.get('choices') or []
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            message = choices[0].get('message')
            if isinstance(message, dict):
                value = message.get('reasoning_content') or message.get('reasoning')
                if isinstance(value, str):
                    yield value
    elif protocol == 'anthropic_messages':
        for block in body.get('content') or []:
            if isinstance(block, dict) and block.get('type') == 'thinking' and isinstance(block.get('thinking'), str):
                yield block['thinking']
    elif protocol == 'openai_responses':
        for item in body.get('output') or []:
            if isinstance(item, dict) and item.get('type') == 'reasoning':
                for block in item.get('summary') or []:
                    if isinstance(block, dict) and isinstance(block.get('text'), str):
                        yield block['text']


# Assemble the completed response in the same shape used by the JSON protocol adapters.
async def read_model_stream(response, protocol, on_reasoning, on_text):
    text = []
    usage = {}
    response_id = finish = None
    async for event in _events(response):
        kind = event.get('type')
        content = None
        if kind in {'error', 'response.failed', 'response.incomplete'} or 'error' in event:
            raise ValueError('model stream was truncated or incomplete')
        if protocol == 'openai_responses':
            if kind == 'response.completed' and isinstance(event.get('response'), dict):
                return event['response']
            reasoning = event.get('delta') if kind == 'response.reasoning_summary_text.delta' else None
            if kind == 'response.output_text.delta':
                content = event.get('delta')
        elif protocol == 'anthropic_messages':
            if kind == 'message_start':
                message = event.get('message') or {}
                response_id = message.get('id')
                usage.update(message.get('usage') or {})
            elif kind == 'message_delta':
                finish = (event.get('delta') or {}).get('stop_reason') or finish
                usage.update(event.get('usage') or {})
            elif kind == 'message_stop':
                if finish:
                    return {'id': response_id, 'stop_reason': finish, 'usage': usage,
                            'content': [{'type': 'text', 'text': ''.join(text)}]}
                break
            delta = (event.get('delta') if kind == 'content_block_delta' else
                     event.get('content_block') if kind == 'content_block_start' else None) or {}
            content = delta.get('text')
            if isinstance(content, str):
                text.append(content)
            reasoning = delta.get('thinking') if delta.get('type') in {'thinking', 'thinking_delta'} else None
        else:
            response_id = event.get('id') or response_id
            usage = event.get('usage') or usage
            choices = event.get('choices') or []
            choice = next((item for item in choices if item.get('index', 0) == 0), {})
            finish = choice.get('finish_reason') or finish
            delta = choice.get('delta') or {}
            content = delta.get('content')
            if isinstance(content, str):
                text.append(content)
            reasoning = delta.get('reasoning_content') or delta.get('reasoning')
        if isinstance(reasoning, str) and reasoning:
            on_reasoning(reasoning)
        if isinstance(content, str) and content:
            on_text(content)
    if protocol == 'openai_chat' and finish:
        return {'id': response_id, 'usage': usage,
                'choices': [{'finish_reason': finish, 'message': {'content': ''.join(text)}}]}
    raise ValueError('model stream was truncated or incomplete')
