"""HTTP request configuration shared by the workbench and immutable case nodes."""
from __future__ import annotations

from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# Reject unknown fields in API test configuration.
class ApiModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


# Represent an editable header or query entry.
class KeyValue(ApiModel):
    key: str = Field(max_length=512)
    value: str = Field(default='', max_length=65536)
    enabled: bool = True

    # Reject carriage returns, line feeds, and NUL characters in an entry.
    @field_validator('key', 'value')
    @classmethod
    def no_newlines(cls, value):
        if '\r' in value or '\n' in value or '\x00' in value:
            raise ValueError('parameter names and values cannot contain CR, LF or NUL')
        return value


# Represent a named test variable and its enabled and secret flags.
class Variable(ApiModel):
    key: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z_][A-Za-z0-9_.-]*$')
    value: Any = ''
    enabled: bool = True
    secret: bool = False


# Describe the authentication settings for an HTTP request.
class Auth(ApiModel):
    type: Literal['none', 'basic', 'bearer', 'api_key'] = 'none'
    username: str = Field(default='', max_length=4096)
    password: str = Field(default='', max_length=4096)
    token: str = Field(default='', max_length=16384)
    key: str = Field(default='X-API-Key', max_length=512)
    value: str = Field(default='', max_length=16384)
    location: Literal['header', 'query'] = 'header'


# Represent a text or file field in a request body.
class BodyField(ApiModel):
    key: str = Field(min_length=1, max_length=512)
    value: str = Field(default='', max_length=1048576)
    type: Literal['text', 'file'] = 'text'
    filename: str = Field(default='upload.bin', max_length=255)
    content_type: str = Field(default='application/octet-stream', max_length=128)
    data_base64: str = Field(default='', max_length=1500000)
    enabled: bool = True


# Describe a request body and its encoding mode.
class RequestBody(ApiModel):
    mode: Literal['none', 'json', 'raw', 'urlencoded', 'formdata', 'binary'] = 'none'
    text: str = Field(default='', max_length=1048576)
    content_type: str = Field(default='text/plain', max_length=128)
    fields: list[BodyField] = Field(default_factory=list, max_length=100)
    filename: str = Field(default='upload.bin', max_length=255)
    data_base64: str = Field(default='', max_length=1500000)


# Define a check against an HTTP response or its timing.
class ApiAssertion(ApiModel):
    kind: Literal['status_code', 'body_contains', 'json_field_equals', 'json_field_exists',
                  'header_equals', 'response_time_less_than']
    expected: Any = None
    path: str | None = Field(default=None, max_length=512)

    # Require a path or numeric expectation when the assertion type needs one.
    @model_validator(mode='after')
    def path_required(self):
        if self.kind in {'json_field_equals', 'json_field_exists', 'header_equals'} and not self.path:
            raise ValueError('this assertion requires a path or header name')
        if self.kind in {'status_code', 'response_time_less_than'} and type(self.expected) not in {int, float}:
            raise ValueError('this assertion requires a numeric expected value')
        return self


# Describe a response value to save as a runtime variable.
class Extraction(ApiModel):
    key: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z_][A-Za-z0-9_.-]*$')
    source: Literal['json', 'header', 'cookie'] = 'json'
    path: str = Field(min_length=1, max_length=512)
    required: bool = True
    secret: bool = False


# Define an HTTP request, its collection location, and its checks.
class ApiRequest(ApiModel):
    name: str = Field(default='未命名请求', min_length=1, max_length=200)
    collection_id: str | None = None
    folder_id: str | None = None
    position: int = Field(default=0, ge=0, le=1000000)
    method: Literal['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] = 'GET'
    url: str = Field(default='', max_length=8192)
    query: list[KeyValue] = Field(default_factory=list, max_length=100)
    headers: list[KeyValue] = Field(default_factory=list, max_length=100)
    auth: Auth = Field(default_factory=Auth)
    body: RequestBody = Field(default_factory=RequestBody)
    variables: list[Variable] = Field(default_factory=list, max_length=100)
    assertions: list[ApiAssertion] = Field(default_factory=list, max_length=100)
    extractions: list[Extraction] = Field(default_factory=list, max_length=100)
    timeout_ms: int = Field(default=10000, strict=True, ge=100, le=120000)
    follow_redirects: bool = False
    proxy: Literal['direct', 'system'] = 'direct'
    compatibility_warnings: list[str] = Field(default_factory=list, max_length=30)


# Group requests and provide variables shared across the collection.
class Collection(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default='', max_length=4000)
    variables: list[Variable] = Field(default_factory=list, max_length=100)


# Describe a nested folder within an API collection.
class Folder(ApiModel):
    name: str = Field(min_length=1, max_length=200)
    collection_id: str
    parent_id: str | None = None
    description: str = Field(default='', max_length=4000)
    position: int = Field(default=0, ge=0, le=1000000)


# Store a named set of variables for an execution environment.
class Environment(Collection):
    pass


# Collect a request and its execution overrides.
class ExecuteRequest(ApiModel):
    request: ApiRequest
    request_id: str | None = None
    environment_id: str | None = None
    variables: dict[str, Any] = Field(default_factory=dict)


# Specify environment and failure handling for a collection run.
class CollectionRun(ApiModel):
    environment_id: str | None = None
    variables: dict[str, Any] = Field(default_factory=dict)
    stop_on_failure: bool = True


# Identify a tree item and its version for a reorder.
class TreeItem(ApiModel):
    kind: Literal['requests', 'folders']
    id: str
    version: int = Field(ge=1)


# Specify the desired order of immediate children under a tree parent.
class TreeReorder(ApiModel):
    collection_id: str
    parent_id: str | None = None
    items: list[TreeItem] = Field(max_length=1000)


RECORD_FIELDS = {'id', 'version', 'created_at', 'updated_at'}


# Remove storage metadata before validating a saved configuration.
def configuration(record: dict) -> dict:
    return {key: value for key, value in record.items() if key not in RECORD_FIELDS}
