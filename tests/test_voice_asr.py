# -*- coding: utf-8 -*-
"""ASR 适配器：DeepSeek multipart、百炼兼容 JSON、provider 自动判断。"""
import importlib.util
import io
import json
import unittest
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("voice_asr", ROOT / "bridge" / "voice.py")
voice = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(voice)


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class VoiceAsrTests(unittest.TestCase):
    def test_auto_detects_deepseek_and_sends_multipart(self):
        calls = []

        def urlopen(req, timeout=0):
            calls.append((req, timeout))
            return FakeResponse({"text": "你好", "duration_ms": 1200})

        with mock.patch.object(voice, "_open_asr", urlopen):
            text = voice.asr_transcribe(
                b"RIFFfakewav", "sk-test", "", "https://api.deepseek.com/v1/tools/asr", 30, "auto"
            )

        self.assertEqual(text, "你好")
        req, timeout = calls[0]
        self.assertEqual(timeout, 30)
        self.assertEqual(req.full_url, "https://api.deepseek.com/v1/tools/asr")
        self.assertEqual(req.headers["Authorization"], "Bearer sk-test")
        self.assertIn("multipart/form-data; boundary=", req.headers["Content-type"])
        self.assertIn(b'name="file"; filename="voice.wav"', req.data)
        self.assertIn(b"RIFFfakewav", req.data)

    def test_explicit_dashscope_keeps_json_shape(self):
        calls = []

        def urlopen(req, timeout=0):
            calls.append(req)
            return FakeResponse({"output": {"choices": [{"message": {"content": [{"text": "百炼结果"}]}}]}})

        with mock.patch.object(voice, "_open_asr", urlopen):
            text = voice.asr_transcribe(
                b"wav", "dash-key", "qwen3-asr-flash",
                "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
                30, "dashscope",
            )

        self.assertEqual(text, "百炼结果")
        body = json.loads(calls[0].data.decode("utf-8"))
        self.assertEqual(body["model"], "qwen3-asr-flash")
        self.assertIn("data:audio/wav;base64,", body["input"]["messages"][0]["content"][0]["audio"])

    def test_auto_provider_by_base_url(self):
        self.assertEqual(voice.effective_provider("auto", "https://api.deepseek.com/v1/tools/asr"), "deepseek")
        self.assertEqual(voice.effective_provider("auto", "https://dashscope.aliyuncs.com/x"), "dashscope")
        self.assertEqual(voice.effective_provider("auto", "https://example.com/asr"), "custom")
        self.assertEqual(voice.effective_provider("deepseek", "https://dashscope.aliyuncs.com/x"), "deepseek")

    def test_missing_key_fails_before_request(self):
        with self.assertRaises(RuntimeError):
            voice.asr_transcribe(b"wav", "", "", "https://api.deepseek.com/v1/tools/asr", 30, "deepseek")

    def test_redirect_does_not_forward_audio_or_authorization(self):
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append(self.path)
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                self.send_response(302)
                self.send_header('Location', '/key-sink')
                self.end_headers()

            def do_GET(self):
                calls.append(self.path)
                self.send_response(200)
                self.end_headers()

            def log_message(self, *args):
                pass

        import urllib.request
        import urllib.error
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            req = urllib.request.Request('http://127.0.0.1:%d/asr' % server.server_port,
                                         data=b'fixture-audio', headers={'Authorization': 'Bearer unit-only'})
            with self.assertRaises(urllib.error.HTTPError) as error:
                voice._open_asr(req, timeout=3)
            self.assertEqual(error.exception.code, 302)
            error.exception.close()
            self.assertEqual(calls, ['/asr'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    unittest.main()
