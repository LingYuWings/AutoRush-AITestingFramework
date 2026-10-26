"""Versioned provider presets; network connection testing is intentionally separate."""

from autorush.llm.models import CredentialType, ModelCapability, ProviderPreset


COMMON = [
    ModelCapability.TEXT_ONLY,
    ModelCapability.STRUCTURED_OUTPUT,
    ModelCapability.TOOL_CALLING,
]

PROVIDER_PRESETS = [
    ProviderPreset(id="local_openai", display_name="llama.cpp / 本地兼容服务", regions=["local"], protocols=["openai_chat", "openai_responses", "anthropic_messages"], credential_types=[CredentialType.LOCAL], capabilities=COMMON + [ModelCapability.VISION], suggested_base_url="http://127.0.0.1:8080/v1", compliance_note="仅回环地址无凭据；视觉能力须用实际图片验证。"),
    ProviderPreset(id="openai", display_name="OpenAI", regions=["global"], protocols=["openai_responses", "openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON + [ModelCapability.VISION], suggested_base_url="https://api.openai.com/v1", documentation_url="https://developers.openai.com/api/reference/overview", compliance_note="使用服务端 API Key；套餐和数据区域由管理员按合同确认。"),
    ProviderPreset(id="anthropic", display_name="Anthropic", regions=["global"], protocols=["anthropic_messages"], credential_types=[CredentialType.API_KEY], capabilities=COMMON + [ModelCapability.VISION], compliance_note="仅允许服务条款覆盖的 API 凭证。"),
    ProviderPreset(id="gemini", display_name="Google Gemini", regions=["global"], protocols=["gemini_native", "openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON + [ModelCapability.VISION], compliance_note="使用获准的 Gemini API 项目与区域。"),
    ProviderPreset(id="aliyun_bailian", display_name="阿里云百炼", regions=["cn-beijing", "international"], protocols=["openai_chat"], credential_types=[CredentialType.API_KEY, CredentialType.TOKEN_PLAN, CredentialType.CODING_PLAN], capabilities=COMMON + [ModelCapability.VISION], documentation_url="https://help.aliyun.com/zh/model-studio/token-plan-overview", compliance_note="Coding Plan 不允许用于本平台后端自动化调用；应使用获准的 API Key 或 Token Plan。"),
    ProviderPreset(id="deepseek", display_name="DeepSeek", regions=["china"], protocols=["openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON, compliance_note="使用官方开放平台 API 凭证。"),
    ProviderPreset(id="zhipu", display_name="智谱 GLM", regions=["china"], protocols=["openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON + [ModelCapability.VISION], compliance_note="使用获准的开放平台 API 凭证。"),
    ProviderPreset(id="moonshot", display_name="Moonshot Kimi", regions=["china"], protocols=["openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON, compliance_note="使用获准的开放平台 API 凭证。"),
    ProviderPreset(id="minimax", display_name="MiniMax", regions=["china", "global"], protocols=["openai_chat", "native"], credential_types=[CredentialType.API_KEY], capabilities=COMMON, compliance_note="按所选地域使用获准的 API 凭证。"),
    ProviderPreset(id="volcano_ark", display_name="火山方舟", regions=["china"], protocols=["openai_chat"], credential_types=[CredentialType.API_KEY], capabilities=COMMON + [ModelCapability.VISION], compliance_note="使用项目授权的推理接入点与 API 凭证。"),
    ProviderPreset(id="ollama", display_name="Ollama（本地）", regions=["local"], protocols=["openai_chat", "ollama_native"], credential_types=[CredentialType.LOCAL], capabilities=COMMON + [ModelCapability.VISION], suggested_base_url="http://127.0.0.1:11434/v1", documentation_url="https://docs.ollama.com/api/openai-compatibility", compliance_note="本地兼容接口使用 /v1；原生协议尚未接入编译器。"),
    ProviderPreset(id="openai_compatible", display_name="自定义 OpenAI 兼容服务", regions=["custom"], protocols=["openai_chat", "openai_responses"], credential_types=[CredentialType.API_KEY, CredentialType.TOKEN_PLAN], capabilities=COMMON + [ModelCapability.VISION], compliance_note="兼容协议不代表套餐获准；管理员必须确认服务条款和数据区域。"),
]

PRESETS_BY_ID = {preset.id: preset for preset in PROVIDER_PRESETS}
