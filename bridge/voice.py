# -*- coding: utf-8 -*-
"""语音识别：Key 查找、ASR 调用与转写清洗。

只处理「语音转文字」这一层；她的语音回复在 launcher / voice_reply.py 里，
不混进这里。engine.py 只负责把当前配置和默认地址传进来。
"""

import json
import os
import re
from urllib.parse import urlsplit


def _open_asr(request, timeout):
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    # 不将聊天密钥和用户音频随服务端重定向发往另一个地址。
    return urllib.request.build_opener(NoRedirect()).open(request, timeout=timeout)


def resolve_voice_config(cfg, root, environ=None):
    """每条语音读取聊天设置，切换模型/Key 后无需重启桥接。"""
    vo = dict(cfg.get('voice') or {})
    mode = vo.get('provider') or ('auto' if vo.get('baseUrl') or vo.get('apiKey') else 'follow')
    if mode != 'follow':
        vo['apiKey'] = resolve_voice_key(cfg, vo.get('baseUrl') or 'https://api.deepseek.com/v1/tools/asr', root)
        return vo
    # 跟随模式绝不回退到另一家的专用 Key，避免换服务商后误用旧凭据。
    result = dict(vo, provider='follow', baseUrl='', model='', apiKey='', supported=False)
    try:
        with open(os.path.join(root, 'data', 'settings.json'), encoding='utf-8-sig') as f:
            st = json.load(f)
    except FileNotFoundError:
        st = {}
    except (ValueError, OSError):
        return result
    if not isinstance(st, dict):
        return result
    keys = st.get('keys') if isinstance(st.get('keys'), dict) else {}
    legacy, llm = cfg.get('deepseek') or {}, cfg.get('llm') or {}
    env = os.environ if environ is None else environ
    provider = st.get('provider') or cfg.get('provider') or legacy.get('provider') or 'deepseek'
    preset = {'deepseek': 'https://api.deepseek.com', 'qwen': 'https://dashscope.aliyuncs.com/compatible-mode/v1'}
    base = st.get('baseUrl') or llm.get('baseUrl') or (legacy.get('baseUrl') if provider == 'deepseek' else '') or preset.get(provider, '')
    try:
        url = urlsplit(base)
        if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443):
            return result
        host, path = (url.hostname or '').lower(), url.path.rstrip('/')
        ds = provider == 'deepseek' and host == 'api.deepseek.com' and path in ('', '/v1')
        qw = provider == 'qwen' and path == '/compatible-mode/v1' and (
            host in ('dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com') or
            re.fullmatch(r'[a-z0-9-]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com', host))
        if not (ds or qw):
            return result
    except ValueError:
        return result
    configured = cfg.get('provider') or legacy.get('provider') or 'deepseek'
    key = st.get('apiKey') if 'apiKey' in st else (
        keys.get(provider) or (llm.get('apiKey') if provider == configured else '') or
        ((legacy.get('apiKey') or env.get('DEEPSEEK_API_KEY')) if provider == 'deepseek' else '') or '')
    result.update(supported=True, provider='deepseek' if ds else 'dashscope', apiKey=str(key or '').strip(),
                  baseUrl='https://' + host + ('/v1/tools/asr' if ds else '/api/v1/services/aigc/multimodal-generation/generation'),
                  model='' if ds else 'qwen3-asr-flash')
    return result


def resolve_voice_key(cfg, default_base_url, root):
    """按优先级找语音识别 Key：voice.apiKey → settings.voiceApiKey/keys.voice
    → 同源服务商 Key（千问）→ 同源聊天 Key → 旧 deepseek.apiKey。

    只复用「与语音接口同源」的 Key，避免把 DeepSeek 的聊天 Key 发给阿里云。
    """
    vo = (cfg.get("voice") or {}) if isinstance(cfg, dict) else {}
    key = str(vo.get("apiKey") or "").strip()
    if key:
        return key

    def origin(value):
        try:
            u = urlsplit(str(value or ""))
            return (u.scheme.lower(), (u.hostname or "").lower(), u.port or (443 if u.scheme == "https" else 80))
        except Exception:
            return None

    destination = origin(vo.get("baseUrl") or default_base_url)
    host = destination[1] if destination else ""
    try:
        with open(os.path.join(root, "data", "settings.json"), "r", encoding="utf-8-sig") as sf:
            st = json.load(sf)
        keys = st.get("keys") or {}
        dedicated = str(st.get("voiceApiKey") or keys.get("voice") or "").strip()
        if dedicated:
            return dedicated
        if host in {"dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"}:
            matching = str(keys.get("qwen") or (st.get("apiKey") if st.get("provider") == "qwen" else "") or "").strip()
            if matching:
                return matching
        if destination and destination == origin(st.get("baseUrl")):
            return str(st.get("apiKey") or "").strip()
    except Exception:
        pass
    legacy = cfg.get("deepseek") or {}
    if destination and destination == origin(legacy.get("baseUrl") or "https://api.deepseek.com"):
        return str(legacy.get("apiKey") or "").strip()
    return ""


def effective_provider(provider, base_url):
    """auto 按接口地址判断；这样老配置的百炼地址不会因为新默认值被改走。"""
    p = str(provider or "auto").strip().lower()
    if p in ("deepseek", "dashscope", "custom"):
        return p
    url = str(base_url or "").strip()
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        path = (parts.path or "").rstrip("/").lower()
    except ValueError:
        host, path = "", ""
    if host == "dashscope.aliyuncs.com" or host.startswith("dashscope-"):
        return "dashscope"
    if host == "api.deepseek.com" or host.endswith(".deepseek.com") or path.endswith("/v1/tools/asr"):
        return "deepseek"
    return "custom"


def _deepseek_transcribe(wav_bytes, api_key, base_url, timeout):
    import urllib.error
    import urllib.request
    import uuid

    boundary = "----whale" + uuid.uuid4().hex
    head = (
        "--%s\r\n"
        'Content-Disposition: form-data; name="file"; filename="voice.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n" % boundary
    ).encode("utf-8")
    tail = ("\r\n--%s--\r\n" % boundary).encode("utf-8")
    body = head + wav_bytes + tail
    req = urllib.request.Request(
        base_url,
        data=body,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "Content-Length": str(len(body)),
        },
    )
    try:
        with _open_asr(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # 只记状态码，不把响应正文（可能回显音频信息）带进日志。
        raise RuntimeError("DeepSeek ASR HTTP %s" % exc.code)
    return str(data.get("text") or "").strip()


def asr_transcribe(wav_bytes, api_key, model, base_url, timeout=90, provider="auto"):
    """把 wav 字节交给语音识别接口，返回文字；失败抛异常或返回空串。"""
    import base64
    import urllib.request

    if not api_key:
        raise RuntimeError("没有可用的语音识别 Key")
    mode = effective_provider(provider, base_url)
    if mode == "deepseek":
        return _deepseek_transcribe(wav_bytes, api_key, base_url, timeout)
    payload = {
        "model": model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"audio": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode()}],
            }]
        },
    }
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    with _open_asr(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    try:
        text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    except Exception:
        text = ""
    return str(text or "").strip()


def clean_transcript(text):
    """去掉只剩标点的转写结果。"""
    t = str(text or "").strip()
    t = t.strip("，,。.！!？?…~～、 ")
    return t if len(t) >= 1 else ""
