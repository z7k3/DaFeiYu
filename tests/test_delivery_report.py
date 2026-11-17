"""送达失败回执函数的单元测试（不导入 engine：它有启动副作用）。

背景：本地桥接发送失败/被限流丢弃时，要用 report_delivery_failure 向内核回报，
内核才能把「她说过了但没送到」记进动作账本（见 tests/delivery-ledger.test.js）。
这里用 bridge_ast 把方法单独抽出来跑（self 参数会被剥掉，self.bot_url/token 走 env），
锁三件事：
  1. 请求打到 /api/bridge/delivery-failed，带 token 头和结构化 payload；
  2. 群聊/私聊的 chatType 归因正确；
  3. HTTP 非 200 或请求抛异常都不能往外抛（回执失败绝不能影响消息处理主流程）。
"""
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'tests') not in sys.path:
    sys.path.insert(0, str(ROOT / 'tests'))
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))

from bridge_ast import load_function  # noqa: E402

BOT_URL = 'http://127.0.0.1:8787/webhook/wechat'


class FakeResp:
    def __init__(self, status_code):
        self.status_code = status_code


class FakeHTTP:
    def __init__(self, status_code=200, raise_error=None):
        self.status_code = status_code
        self.raise_error = raise_error
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.raise_error:
            raise self.raise_error
        return FakeResp(self.status_code)


class FakeG:
    """只暴露回执函数用到的 G 成员；G 本体有启动副作用，绝不 import。"""

    def __init__(self, http):
        self.LOCAL_HTTP = http
        self.throttled = []

    def log_throttled(self, key, msg, **kwargs):
        self.throttled.append((key, msg))


def make_report(http, token='tok-1'):
    env = {'G': FakeG(http), 'bot_url': BOT_URL, 'token': token}
    report = load_function('report_delivery_failure', env)
    return report, env['G']


class DeliveryReportTest(unittest.TestCase):
    def test_reports_to_kernel_with_token_and_payload(self):
        http = FakeHTTP(200)
        report, _ = make_report(http)
        report('wxid_peer', 2, 'send_failed')
        self.assertEqual(len(http.calls), 1)
        url, kwargs = http.calls[0]
        self.assertEqual(url, 'http://127.0.0.1:8787/api/bridge/delivery-failed')
        self.assertEqual(kwargs['headers']['x-bot-token'], 'tok-1')
        self.assertEqual(kwargs['headers']['x-whale-bridge'], '1')
        payload = kwargs['json']
        self.assertEqual(payload['chatId'], 'wxid_peer')
        self.assertEqual(payload['chatType'], 'private')
        self.assertEqual(payload['bubbles'], 2)
        self.assertEqual(payload['reason'], 'send_failed')

    def test_group_chat_reports_group_type(self):
        http = FakeHTTP(200)
        report, _ = make_report(http, token='')
        report('12345@chatroom', 1, 'rate_limited')
        payload = http.calls[0][1]['json']
        self.assertEqual(payload['chatType'], 'group')
        self.assertEqual(payload['reason'], 'rate_limited')
        # token 为空时不能带空 token 头
        self.assertNotIn('x-bot-token', http.calls[0][1]['headers'])

    def test_http_rejection_never_raises(self):
        http = FakeHTTP(403)
        report, fake_g = make_report(http)
        report('wxid_peer', 1, 'send_failed')  # 不应抛
        self.assertTrue(fake_g.throttled, '被拒时要留一条节流日志')

    def test_network_error_never_raises(self):
        http = FakeHTTP(raise_error=ConnectionError('refused'))
        report, fake_g = make_report(http)
        report('wxid_peer', 1, 'send_failed')  # 不应抛
        self.assertTrue(fake_g.throttled, '网络异常时也要留一条节流日志')


if __name__ == '__main__':
    unittest.main()
