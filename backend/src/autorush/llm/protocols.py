"""Small protocol adapters shared by model execution and configuration probes."""
import base64
import ipaddress
import json
from urllib.parse import urlsplit


SUPPORTED_PROTOCOLS = {'openai_chat', 'openai_responses', 'anthropic_messages'}


def is_loopback_url(url):
    host = urlsplit(url).hostname or ''
    if host == 'localhost': return True
    try: return ipaddress.ip_address(host).is_loopback
    except ValueError: return False


def model_endpoint(base_url, protocol, *, catalog=False):
    base = base_url.rstrip('/')
    for suffix in ('/chat/completions', '/responses', '/messages', '/models'):
        if base.endswith(suffix):
            base = base[:-len(suffix)]
            break
    if not urlsplit(base).path or (protocol == 'anthropic_messages' and not base.endswith('/v1')):
        base += '/v1'
    return base + ('/models' if catalog else '/messages' if protocol == 'anthropic_messages'
                   else '/responses' if protocol == 'openai_responses' else '/chat/completions')


def build_model_request(config, system, user, images, schema):
    if len(images) > 2 or any(not isinstance(image, bytes) or len(image) > 1_000_000
                              or not image.startswith(b'\xff\xd8') for image in images):
        raise ValueError('model images must be at most two bounded JPEGs')
    if schema and not (config.protocol=='openai_chat' and config.credential_type=='local'):
        user += '\nRequired JSON Schema:\n' + json.dumps(schema, ensure_ascii=False)
    encoded = [base64.b64encode(image).decode('ascii') for image in images]
    headers = {}
    payload = {'model': config.model_id, 'max_tokens': 1024, 'temperature': 0.1}
    if config.protocol == 'anthropic_messages':
        content = [{'type': 'text', 'text': user}] + [
            {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/jpeg', 'data': image}} for image in encoded]
        payload.update(system=system, messages=[{'role': 'user', 'content': content}])
        headers['anthropic-version'] = '2023-06-01'
    elif config.protocol == 'openai_responses':
        payload.pop('max_tokens')
        payload.pop('temperature')
        content = [{'type': 'input_text', 'text': user}] + [
            {'type': 'input_image', 'image_url': 'data:image/jpeg;base64,' + image} for image in encoded]
        payload.update(instructions=system, input=[{'role': 'user', 'content': content}], store=False,
                       max_output_tokens=1024, text={'format': {'type': 'json_object'}})
    else:
        content = ([{'type': 'text', 'text': user}] + [
            {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,' + image}} for image in encoded]) if images else user
        payload.update(messages=[{'role': 'system', 'content': system}, {'role': 'user', 'content': content}],
                       response_format={'type': 'json_object'})
        if schema and config.credential_type=='local':
            payload['response_format']={'type':'json_schema','json_schema':{'name':'autorush_decision','schema':schema}}
    return model_endpoint(config.base_url, config.protocol), payload, headers


def text_content(content):
    if isinstance(content, str): return content
    if isinstance(content, list):
        texts = [item['text'] for item in content if isinstance(item, dict)
                 and item.get('type') in {'text', 'output_text'} and isinstance(item.get('text'), str)]
        if texts: return ''.join(texts)
    raise ValueError('model response did not contain text')


def parse_model_response(body, protocol):
    if not isinstance(body, dict): raise ValueError('model response must be an object')
    if protocol == 'anthropic_messages':
        reason = body.get('stop_reason')
        content = text_content(body.get('content'))
    elif protocol == 'openai_responses':
        reason = body.get('status')
        if isinstance(body.get('output_text'), str): content = body['output_text']
        else:
            content = ''.join(text_content(item.get('content')) for item in body.get('output', [])
                              if isinstance(item, dict) and isinstance(item.get('content'), list))
            if not content: raise ValueError('model response did not contain output text')
    else:
        choice = body['choices'][0]
        reason = choice.get('finish_reason')
        content = text_content(choice['message'].get('content'))
    if reason in {'length', 'abort', 'max_tokens', 'incomplete', 'failed', 'cancelled'}:
        raise ValueError('model response was truncated or incomplete')
    usage = body.get('usage') if isinstance(body.get('usage'), dict) else {}
    return content, reason, usage
