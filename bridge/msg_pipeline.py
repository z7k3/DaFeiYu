# -*- coding: utf-8 -*-
"""消息调度：**按会话串行、跨会话并发**。

从 `engine.py` 里拆出来的第一块（见 `bridge/README.md` 的拆分计划）。

为什么需要：旧实现是 `ThreadPoolExecutor(max_workers=1)`，所有消息挤一条队。
群里连发 3 张长截图时，第一张的 OCR 要几分钟，后面全堵着 —— 收消息、识别图片、
等模型、发送全串在一条线上。

三条规则：

1. **同一个会话必须串行**。否则两条消息并发调模型，回复顺序会乱，
   还会抢着写同一个会话的上下文。
2. **跨会话可以并发**。不同人的消息互不相干。
3. **发送不由这里管**。`send_text` 内部有 `send_lock`，UIA 操作天然只能
   一个线程碰，所以发送永远是串行的。

实现：固定大小线程池 + 每个会话一条 FIFO。只有队首那条真正占线程，
后面排队的不会白占 worker（否则 4 个慢会话就能把池子占满）。

上面是「谁来跑」。`MessageBatches` 管的是「跑之前攒什么」：同一会话在
上一轮还没跑完时又来的消息，先攒着，等这轮结束一起处理。这样连发两三条
不会再变成「第一条回完、第二条已经过期被丢掉」。

这个文件不依赖 wechatauto / win32，可以单独跑
`python scripts/bridge-pipeline-selftest.py` 验证。
"""

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
try:
    from bridge_log import safe_id
except ImportError:  # 测试里按 `bridge.msg_pipeline` 导入时走包内相对路径
    from .bridge_log import safe_id
try:
    from runtime_log_throttle import log_throttled as bounded_log
except ImportError:
    from .runtime_log_throttle import log_throttled as bounded_log


def split_runs(items, key="sender_username"):
    """把一批消息按「同一个人连着说」切成若干段。

    同一个群里张三说完李四接着说，不能并成一条 —— 并了就把话算到一个人头上，
    回复也会张冠李戴。只合并「相邻 + 同一发送者」的消息。
    """
    runs = []
    for it in items:
        who = (it or {}).get(key) or ""
        if runs and ((runs[-1][0] or {}).get(key) or "") == who:
            runs[-1].append(it)
        else:
            runs.append([it])
    return runs


def mergeable(messages):
    """这几条能不能合成一次请求：都是纯文本。

    （发送者是否相同由 split_runs 保证；图片/语音的正文是识别结果，
    混在一起会分不清哪句话配哪张图，所以不合并。）
    """
    return len(messages) > 1 and all((m.get("type") or "") == "文本" for m in messages)


# —— 断句等待：把「一句话拆成几条发」的碎片等齐 ———

# 句中出现这些词且没有句末标点：大概率话没说完（「上班已经上到」）
_INCOMPLETE_CONN_RE = re.compile(
    r'已经|还没|还没有|刚刚|正在|我想|我想说|我感觉|感觉|觉得|但是|可是|然后|因为|所以|'
    r'就是|准备|打算|要不要|是不是|能不能|会不会|好不好'
)
_SENTENCE_END_RE = re.compile(r'[。！？!?~～⁉⁇]

def _text_of(item):
    it = item or {}
    return str(it.get('content') or it.get('text') or '')

def looks_incomplete(text):
    """这条像不像被拆成两半的前半段。

    有句末标点（。！？~…）结尾 → 默认说完；以逗号/冒号收尾 → 明显还有下半句；
    句中含续接词（已经/还没/但是…）→ 大概率没说完；又短（≤14 字）又没有任何
    标点 → 群聊连发习惯下的碎片，等一等。
    """
    s = (text or '').strip()
    if not s or len(s) > 40:
        return False
    if _SENTENCE_END_RE.search(s):
        return False
    if _COMPLETE_QUESTION_RE.search(s):
        return False
    if s[-1] in '，,、：:—-':
        return True
    # 续接词只在 ≤20 字的消息里才算信号：长句不带标点的人本来就不打标点，
    # 「但是」「已经」出现在完整长句里太常见，按它判定会误延迟。
    if len(s) <= 20 and _INCOMPLETE_CONN_RE.search(s):
        return True
    return len(s) <= 14


class MessageBatches:
    """按会话攒消息：等这个会话的上一轮跑完，再整批交出去。

    为什么需要它：同一会话是串行的。第一条正在生成/发送时，后面连发的几条
    只能排队；旧实现是**出队时**按 `create_time` 判「过期」，于是第二条要等
    10~30 秒才出队，一出队就已经是「过期消息」被丢掉 —— 表现就是
    「连发两三条，她只回第一条」。现在过期只在**收到那一刻**判一次
    （见 engine.on_message），进了这个队列就一定会被处理；同一轮攒下的几条
    合并成一次生成，不会一人一句连回三遍。

    与 MessagePipeline 的分工：本类只管「攒什么」，Pipeline 管「谁来跑、按什么
    顺序跑」。push 返回 True 时，调用方才需要向 Pipeline 投一次 flush。
    """

    def __init__(self, limit=8, log=None, flush_due=None,
                 incomplete_wait=8.0, incomplete_max=20.0):
        self.limit = max(1, int(limit))
        self.log = log or (lambda *a: None)
        # 断句等待到期时回调 flush_due(chat, listener)：等同一个人发完下半句再投递
        self.flush_due = flush_due
        self.incomplete_wait = max(0.0, float(incomplete_wait))
        self.incomplete_max = max(self.incomplete_wait, float(incomplete_max))
        self._guard = threading.Lock()
        self._timers = {}       # chat -> 断句等待的 Timer
        self._listeners = {}    # chat -> 最后一条消息的 listener（延迟投递要用）
        self._wait_started = {} # chat -> 等待开始时间（顺延封顶用）
        self._pending = {}          # chat -> [msg]
        self._flush_queued = set()  # 已经排了 flush、还没被 take 的会话
        self.stats = {"in": 0, "batches": 0, "merged": 0, "dropped": 0}

    def push(self, chat, item, listener=None):
        """攒一条。返回 True 表示这个会话还没有排队的 flush，调用方要投一个。

        首条消息如果像「拆成两半的前半段」（looks_incomplete），不立即投：起定时器
        等 incomplete_wait 秒，等同一个人发完下半句，再由 flush_due 一次性投递。
        等待期间同一个人又发碎片且仍未说完 → 顺延等待（总量 incomplete_max 封顶）。
        """
        chat = chat or "_"
        with self._guard:
            self._listeners[chat] = listener
            q = self._pending.setdefault(chat, [])
            q.append(item)
            self.stats["in"] += 1
            if len(q) > self.limit:
                # 极端刷屏（一轮里攒了几十条）：留最新的，丢最早的，
                # 但要记账 —— 以前是静默丢，用户只知道「她漏回了」。
                q.pop(0)
                self.stats["dropped"] += 1
                self.log("会话 %s 一轮攒了超过 %d 条，丢掉最早的一条" % (safe_id(chat), self.limit))
            if chat not in self._flush_queued:
                self._flush_queued.add(chat)
                if self.flush_due and self.incomplete_wait > 0 and looks_incomplete(_text_of(item)):
                    self._arm_wait(chat, self.incomplete_wait)
                    self.log('像拆成两半的前半段，等 %.0f 秒看下半句：%s'
                             % (self.incomplete_wait, _text_of(item)[:24]))
                    return False
                return True
            # 等待期间同一个人又发碎片且仍未说完 → 顺延（总量封顶，避免无限等）
            if chat in self._timers and self.flush_due and self.incomplete_wait > 0 \
                    and looks_incomplete(_text_of(item)):
                elapsed = time.time() - self._wait_started.get(chat, time.time())
                extra = min(self.incomplete_wait, max(0.0, self.incomplete_max - elapsed))
                if extra > 0.5:
                    old_timer = self._timers.get(chat)
                    if old_timer:
                        old_timer.cancel()
                    self._arm_wait(chat, extra)
            return False

    def take(self, chat):
        """取走这个会话攒下的全部消息（取走即清空，并把 flush 标记清掉）。

        标记要在**开始处理时**清，不能等处理完：处理期间新来的消息必须能
        再排一次 flush，否则它们会一直躺在待处理里没人管。
        """
        chat = chat or "_"
        with self._guard:
            self._flush_queued.discard(chat)
            self._timers.pop(chat, None)
            items = self._pending.pop(chat, [])
            if items:
                self.stats["batches"] += 1
                self.stats["merged"] += max(0, len(items) - 1)
        return items

    def _arm_wait(self, chat, delay):
        self._wait_started[chat] = time.time()
        t = threading.Timer(delay, self._fire_wait, args=(chat,))
        t.daemon = True
        self._timers[chat] = t
        t.start()

    def _fire_wait(self, chat):
        with self._guard:
            self._timers.pop(chat, None)
            listener = self._listeners.get(chat)
        # 回调必须在锁外调：submit → worker → take 会再进 _guard，同线程重入会死锁
        cb = self.flush_due
        if cb:
            try:
                cb(chat, listener)
            except Exception as e:
                self.log('断句等待触发的投递失败：', repr(e))

    def release(self, chat):
        """放弃「已排 flush」的标记（投递失败时用）。消息仍留在待处理里。"""
        with self._guard:
            self._flush_queued.discard(chat or "_")

    def pending(self, chat):
        with self._guard:
            return len(self._pending.get(chat or "_", []))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                chats=len(self._pending),
                queued=sum(len(v) for v in self._pending.values()),
            )


class MessagePipeline:
    def __init__(self, workers=4, per_chat_limit=8, log=None, name="whale-decider",
                 drop_log_interval=10.0):
        self.workers = max(1, int(workers))
        self.per_chat_limit = max(1, int(per_chat_limit))
        self.drop_log_interval = max(0.0, float(drop_log_interval))
        self.log = log or (lambda *a: None)
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=name)
        self._guard = threading.Lock()
        self._queues = {}          # chat -> [(fn, args)]
        self._running = set()      # 正在被处理的会话
        self._closed = False
        # 积压日志节流：卡住时每条新消息都溢出一次，原样打印就是刷屏。
        self._drop_log_at = {}     # 有界的日志窗口记录，不作业务去重
        self._drop_count = {}      # chat -> 本窗口内已丢条数
        self.stats = {"in": 0, "done": 0, "dropped": 0, "errors": 0, "peak_queue": 0}

    def submit(self, chat, fn, *args):
        """投递一条任务。返回 False 表示已经 close。"""
        chat = chat or "_"
        with self._guard:
            if self._closed:
                return False
            self.stats["in"] += 1
            q = self._queues.setdefault(chat, [])
            q.append((fn, args))
            if len(q) > self.per_chat_limit:
                # 同一会话积压太多：丢最旧的。这是安全网 —— 正常情况下走不到：
                # engine 每个会话同时只排一个 flush 任务，消息本身由
                # MessageBatches 攒着，不占这里的队列额度。
                q.pop(0)
                self.stats["dropped"] += 1
                self._drop_count[chat] = self._drop_count.get(chat, 0) + 1

                def emit_drop():
                    n = self._drop_count.pop(chat, 1)
                    self.log("会话积压超过 %d 条，%.0f 秒内丢掉 %d 条：%s"
                             % (self.per_chat_limit, self.drop_log_interval, n, safe_id(chat)))
                bounded_log(self._drop_log_at, chat, ttl=self.drop_log_interval,
                            emit=emit_drop, clock=time.monotonic)
                # These are log counters only; business queues and deduplication
                # remain untouched when old log keys expire or are evicted.
                for old_chat in tuple(self._drop_count):
                    if old_chat not in self._drop_log_at:
                        self._drop_count.pop(old_chat, None)
            if len(q) > self.stats["peak_queue"]:
                self.stats["peak_queue"] = len(q)
            if chat in self._running:
                return True
            self._running.add(chat)
        # submit 保持在锁外（收进锁内会让 drain 线程晚一步拿到锁、队首被积压上限
        # 挤掉），改用 try/except 挡住与 close() 的竞态（L7）：close() 把 _closed
        # 置真后才 shutdown 线程池，这里撞上「已经关池」时不能把 RuntimeError
        # 抛给消息线程（旧实现会话会永久卡死），而是清掉本会话痕迹、按「已关闭」
        # 语义返回 False。
        try:
            self._pool.submit(self._drain, chat)
        except RuntimeError:
            with self._guard:
                self._running.discard(chat)
                self._queues.pop(chat, None)
                self._closed = True
            self.log("消息调度已关闭，这条没能排上：", safe_id(chat))
            return False
        return True

    def _drain(self, chat):
        while True:
            with self._guard:
                q = self._queues.get(chat)
                if not q:
                    self._running.discard(chat)
                    self._queues.pop(chat, None)
                    return
                fn, args = q.pop(0)
            try:
                fn(*args)
                with self._guard:
                    self.stats["done"] += 1
            except Exception as e:                 # noqa: BLE001
                with self._guard:
                    self.stats["errors"] += 1
                self.log("处理消息异常：", repr(e))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                running=len(self._running),
                queued=sum(len(v) for v in self._queues.values()),
                workers=self.workers,
            )

    def close(self, wait=True):
        with self._guard:
            self._closed = True
        self._pool.shutdown(wait=wait)
)
# 疑问语气词收尾 = 一句完整的话（「你在干嘛」「吃了吗」「有什么安排吗」）：
# 等下半句是为「话没说完」服务的，问句已经能答了，再等 8 秒纯增延迟
# （2026-11-14 实见：短问句每轮都吃满 8 秒等待，体感回复明显变慢）。
_COMPLETE_QUESTION_RE = re.compile(r'(?:吗|嘛|呢|吧)

def _text_of(item):
    it = item or {}
    return str(it.get('content') or it.get('text') or '')

def looks_incomplete(text):
    """这条像不像被拆成两半的前半段。

    有句末标点（。！？~…）结尾 → 默认说完；以逗号/冒号收尾 → 明显还有下半句；
    句中含续接词（已经/还没/但是…）→ 大概率没说完；又短（≤14 字）又没有任何
    标点 → 群聊连发习惯下的碎片，等一等。
    """
    s = (text or '').strip()
    if not s or len(s) > 40:
        return False
    if _SENTENCE_END_RE.search(s):
        return False
    if s[-1] in '，,、：:—-':
        return True
    # 续接词只在 ≤20 字的消息里才算信号：长句不带标点的人本来就不打标点，
    # 「但是」「已经」出现在完整长句里太常见，按它判定会误延迟。
    if len(s) <= 20 and _INCOMPLETE_CONN_RE.search(s):
        return True
    return len(s) <= 14


class MessageBatches:
    """按会话攒消息：等这个会话的上一轮跑完，再整批交出去。

    为什么需要它：同一会话是串行的。第一条正在生成/发送时，后面连发的几条
    只能排队；旧实现是**出队时**按 `create_time` 判「过期」，于是第二条要等
    10~30 秒才出队，一出队就已经是「过期消息」被丢掉 —— 表现就是
    「连发两三条，她只回第一条」。现在过期只在**收到那一刻**判一次
    （见 engine.on_message），进了这个队列就一定会被处理；同一轮攒下的几条
    合并成一次生成，不会一人一句连回三遍。

    与 MessagePipeline 的分工：本类只管「攒什么」，Pipeline 管「谁来跑、按什么
    顺序跑」。push 返回 True 时，调用方才需要向 Pipeline 投一次 flush。
    """

    def __init__(self, limit=8, log=None, flush_due=None,
                 incomplete_wait=8.0, incomplete_max=20.0):
        self.limit = max(1, int(limit))
        self.log = log or (lambda *a: None)
        # 断句等待到期时回调 flush_due(chat, listener)：等同一个人发完下半句再投递
        self.flush_due = flush_due
        self.incomplete_wait = max(0.0, float(incomplete_wait))
        self.incomplete_max = max(self.incomplete_wait, float(incomplete_max))
        self._guard = threading.Lock()
        self._timers = {}       # chat -> 断句等待的 Timer
        self._listeners = {}    # chat -> 最后一条消息的 listener（延迟投递要用）
        self._wait_started = {} # chat -> 等待开始时间（顺延封顶用）
        self._pending = {}          # chat -> [msg]
        self._flush_queued = set()  # 已经排了 flush、还没被 take 的会话
        self.stats = {"in": 0, "batches": 0, "merged": 0, "dropped": 0}

    def push(self, chat, item, listener=None):
        """攒一条。返回 True 表示这个会话还没有排队的 flush，调用方要投一个。

        首条消息如果像「拆成两半的前半段」（looks_incomplete），不立即投：起定时器
        等 incomplete_wait 秒，等同一个人发完下半句，再由 flush_due 一次性投递。
        等待期间同一个人又发碎片且仍未说完 → 顺延等待（总量 incomplete_max 封顶）。
        """
        chat = chat or "_"
        with self._guard:
            self._listeners[chat] = listener
            q = self._pending.setdefault(chat, [])
            q.append(item)
            self.stats["in"] += 1
            if len(q) > self.limit:
                # 极端刷屏（一轮里攒了几十条）：留最新的，丢最早的，
                # 但要记账 —— 以前是静默丢，用户只知道「她漏回了」。
                q.pop(0)
                self.stats["dropped"] += 1
                self.log("会话 %s 一轮攒了超过 %d 条，丢掉最早的一条" % (safe_id(chat), self.limit))
            if chat not in self._flush_queued:
                self._flush_queued.add(chat)
                if self.flush_due and self.incomplete_wait > 0 and looks_incomplete(_text_of(item)):
                    self._arm_wait(chat, self.incomplete_wait)
                    self.log('像拆成两半的前半段，等 %.0f 秒看下半句：%s'
                             % (self.incomplete_wait, _text_of(item)[:24]))
                    return False
                return True
            # 等待期间同一个人又发碎片且仍未说完 → 顺延（总量封顶，避免无限等）
            if chat in self._timers and self.flush_due and self.incomplete_wait > 0 \
                    and looks_incomplete(_text_of(item)):
                elapsed = time.time() - self._wait_started.get(chat, time.time())
                extra = min(self.incomplete_wait, max(0.0, self.incomplete_max - elapsed))
                if extra > 0.5:
                    old_timer = self._timers.get(chat)
                    if old_timer:
                        old_timer.cancel()
                    self._arm_wait(chat, extra)
            return False

    def take(self, chat):
        """取走这个会话攒下的全部消息（取走即清空，并把 flush 标记清掉）。

        标记要在**开始处理时**清，不能等处理完：处理期间新来的消息必须能
        再排一次 flush，否则它们会一直躺在待处理里没人管。
        """
        chat = chat or "_"
        with self._guard:
            self._flush_queued.discard(chat)
            self._timers.pop(chat, None)
            items = self._pending.pop(chat, [])
            if items:
                self.stats["batches"] += 1
                self.stats["merged"] += max(0, len(items) - 1)
        return items

    def _arm_wait(self, chat, delay):
        self._wait_started[chat] = time.time()
        t = threading.Timer(delay, self._fire_wait, args=(chat,))
        t.daemon = True
        self._timers[chat] = t
        t.start()

    def _fire_wait(self, chat):
        with self._guard:
            self._timers.pop(chat, None)
            listener = self._listeners.get(chat)
        # 回调必须在锁外调：submit → worker → take 会再进 _guard，同线程重入会死锁
        cb = self.flush_due
        if cb:
            try:
                cb(chat, listener)
            except Exception as e:
                self.log('断句等待触发的投递失败：', repr(e))

    def release(self, chat):
        """放弃「已排 flush」的标记（投递失败时用）。消息仍留在待处理里。"""
        with self._guard:
            self._flush_queued.discard(chat or "_")

    def pending(self, chat):
        with self._guard:
            return len(self._pending.get(chat or "_", []))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                chats=len(self._pending),
                queued=sum(len(v) for v in self._pending.values()),
            )


class MessagePipeline:
    def __init__(self, workers=4, per_chat_limit=8, log=None, name="whale-decider",
                 drop_log_interval=10.0):
        self.workers = max(1, int(workers))
        self.per_chat_limit = max(1, int(per_chat_limit))
        self.drop_log_interval = max(0.0, float(drop_log_interval))
        self.log = log or (lambda *a: None)
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=name)
        self._guard = threading.Lock()
        self._queues = {}          # chat -> [(fn, args)]
        self._running = set()      # 正在被处理的会话
        self._closed = False
        # 积压日志节流：卡住时每条新消息都溢出一次，原样打印就是刷屏。
        self._drop_log_at = {}     # 有界的日志窗口记录，不作业务去重
        self._drop_count = {}      # chat -> 本窗口内已丢条数
        self.stats = {"in": 0, "done": 0, "dropped": 0, "errors": 0, "peak_queue": 0}

    def submit(self, chat, fn, *args):
        """投递一条任务。返回 False 表示已经 close。"""
        chat = chat or "_"
        with self._guard:
            if self._closed:
                return False
            self.stats["in"] += 1
            q = self._queues.setdefault(chat, [])
            q.append((fn, args))
            if len(q) > self.per_chat_limit:
                # 同一会话积压太多：丢最旧的。这是安全网 —— 正常情况下走不到：
                # engine 每个会话同时只排一个 flush 任务，消息本身由
                # MessageBatches 攒着，不占这里的队列额度。
                q.pop(0)
                self.stats["dropped"] += 1
                self._drop_count[chat] = self._drop_count.get(chat, 0) + 1

                def emit_drop():
                    n = self._drop_count.pop(chat, 1)
                    self.log("会话积压超过 %d 条，%.0f 秒内丢掉 %d 条：%s"
                             % (self.per_chat_limit, self.drop_log_interval, n, safe_id(chat)))
                bounded_log(self._drop_log_at, chat, ttl=self.drop_log_interval,
                            emit=emit_drop, clock=time.monotonic)
                # These are log counters only; business queues and deduplication
                # remain untouched when old log keys expire or are evicted.
                for old_chat in tuple(self._drop_count):
                    if old_chat not in self._drop_log_at:
                        self._drop_count.pop(old_chat, None)
            if len(q) > self.stats["peak_queue"]:
                self.stats["peak_queue"] = len(q)
            if chat in self._running:
                return True
            self._running.add(chat)
        # submit 保持在锁外（收进锁内会让 drain 线程晚一步拿到锁、队首被积压上限
        # 挤掉），改用 try/except 挡住与 close() 的竞态（L7）：close() 把 _closed
        # 置真后才 shutdown 线程池，这里撞上「已经关池」时不能把 RuntimeError
        # 抛给消息线程（旧实现会话会永久卡死），而是清掉本会话痕迹、按「已关闭」
        # 语义返回 False。
        try:
            self._pool.submit(self._drain, chat)
        except RuntimeError:
            with self._guard:
                self._running.discard(chat)
                self._queues.pop(chat, None)
                self._closed = True
            self.log("消息调度已关闭，这条没能排上：", safe_id(chat))
            return False
        return True

    def _drain(self, chat):
        while True:
            with self._guard:
                q = self._queues.get(chat)
                if not q:
                    self._running.discard(chat)
                    self._queues.pop(chat, None)
                    return
                fn, args = q.pop(0)
            try:
                fn(*args)
                with self._guard:
                    self.stats["done"] += 1
            except Exception as e:                 # noqa: BLE001
                with self._guard:
                    self.stats["errors"] += 1
                self.log("处理消息异常：", repr(e))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                running=len(self._running),
                queued=sum(len(v) for v in self._queues.values()),
                workers=self.workers,
            )

    def close(self, wait=True):
        with self._guard:
            self._closed = True
        self._pool.shutdown(wait=wait)
)

def _text_of(item):
    it = item or {}
    return str(it.get('content') or it.get('text') or '')

def looks_incomplete(text):
    """这条像不像被拆成两半的前半段。

    有句末标点（。！？~…）结尾 → 默认说完；以逗号/冒号收尾 → 明显还有下半句；
    句中含续接词（已经/还没/但是…）→ 大概率没说完；又短（≤14 字）又没有任何
    标点 → 群聊连发习惯下的碎片，等一等。
    """
    s = (text or '').strip()
    if not s or len(s) > 40:
        return False
    if _SENTENCE_END_RE.search(s):
        return False
    if s[-1] in '，,、：:—-':
        return True
    # 续接词只在 ≤20 字的消息里才算信号：长句不带标点的人本来就不打标点，
    # 「但是」「已经」出现在完整长句里太常见，按它判定会误延迟。
    if len(s) <= 20 and _INCOMPLETE_CONN_RE.search(s):
        return True
    return len(s) <= 14


class MessageBatches:
    """按会话攒消息：等这个会话的上一轮跑完，再整批交出去。

    为什么需要它：同一会话是串行的。第一条正在生成/发送时，后面连发的几条
    只能排队；旧实现是**出队时**按 `create_time` 判「过期」，于是第二条要等
    10~30 秒才出队，一出队就已经是「过期消息」被丢掉 —— 表现就是
    「连发两三条，她只回第一条」。现在过期只在**收到那一刻**判一次
    （见 engine.on_message），进了这个队列就一定会被处理；同一轮攒下的几条
    合并成一次生成，不会一人一句连回三遍。

    与 MessagePipeline 的分工：本类只管「攒什么」，Pipeline 管「谁来跑、按什么
    顺序跑」。push 返回 True 时，调用方才需要向 Pipeline 投一次 flush。
    """

    def __init__(self, limit=8, log=None, flush_due=None,
                 incomplete_wait=8.0, incomplete_max=20.0):
        self.limit = max(1, int(limit))
        self.log = log or (lambda *a: None)
        # 断句等待到期时回调 flush_due(chat, listener)：等同一个人发完下半句再投递
        self.flush_due = flush_due
        self.incomplete_wait = max(0.0, float(incomplete_wait))
        self.incomplete_max = max(self.incomplete_wait, float(incomplete_max))
        self._guard = threading.Lock()
        self._timers = {}       # chat -> 断句等待的 Timer
        self._listeners = {}    # chat -> 最后一条消息的 listener（延迟投递要用）
        self._wait_started = {} # chat -> 等待开始时间（顺延封顶用）
        self._pending = {}          # chat -> [msg]
        self._flush_queued = set()  # 已经排了 flush、还没被 take 的会话
        self.stats = {"in": 0, "batches": 0, "merged": 0, "dropped": 0}

    def push(self, chat, item, listener=None):
        """攒一条。返回 True 表示这个会话还没有排队的 flush，调用方要投一个。

        首条消息如果像「拆成两半的前半段」（looks_incomplete），不立即投：起定时器
        等 incomplete_wait 秒，等同一个人发完下半句，再由 flush_due 一次性投递。
        等待期间同一个人又发碎片且仍未说完 → 顺延等待（总量 incomplete_max 封顶）。
        """
        chat = chat or "_"
        with self._guard:
            self._listeners[chat] = listener
            q = self._pending.setdefault(chat, [])
            q.append(item)
            self.stats["in"] += 1
            if len(q) > self.limit:
                # 极端刷屏（一轮里攒了几十条）：留最新的，丢最早的，
                # 但要记账 —— 以前是静默丢，用户只知道「她漏回了」。
                q.pop(0)
                self.stats["dropped"] += 1
                self.log("会话 %s 一轮攒了超过 %d 条，丢掉最早的一条" % (safe_id(chat), self.limit))
            if chat not in self._flush_queued:
                self._flush_queued.add(chat)
                if self.flush_due and self.incomplete_wait > 0 and looks_incomplete(_text_of(item)):
                    self._arm_wait(chat, self.incomplete_wait)
                    self.log('像拆成两半的前半段，等 %.0f 秒看下半句：%s'
                             % (self.incomplete_wait, _text_of(item)[:24]))
                    return False
                return True
            # 等待期间同一个人又发碎片且仍未说完 → 顺延（总量封顶，避免无限等）
            if chat in self._timers and self.flush_due and self.incomplete_wait > 0 \
                    and looks_incomplete(_text_of(item)):
                elapsed = time.time() - self._wait_started.get(chat, time.time())
                extra = min(self.incomplete_wait, max(0.0, self.incomplete_max - elapsed))
                if extra > 0.5:
                    old_timer = self._timers.get(chat)
                    if old_timer:
                        old_timer.cancel()
                    self._arm_wait(chat, extra)
            return False

    def take(self, chat):
        """取走这个会话攒下的全部消息（取走即清空，并把 flush 标记清掉）。

        标记要在**开始处理时**清，不能等处理完：处理期间新来的消息必须能
        再排一次 flush，否则它们会一直躺在待处理里没人管。
        """
        chat = chat or "_"
        with self._guard:
            self._flush_queued.discard(chat)
            self._timers.pop(chat, None)
            items = self._pending.pop(chat, [])
            if items:
                self.stats["batches"] += 1
                self.stats["merged"] += max(0, len(items) - 1)
        return items

    def _arm_wait(self, chat, delay):
        self._wait_started[chat] = time.time()
        t = threading.Timer(delay, self._fire_wait, args=(chat,))
        t.daemon = True
        self._timers[chat] = t
        t.start()

    def _fire_wait(self, chat):
        with self._guard:
            self._timers.pop(chat, None)
            listener = self._listeners.get(chat)
        # 回调必须在锁外调：submit → worker → take 会再进 _guard，同线程重入会死锁
        cb = self.flush_due
        if cb:
            try:
                cb(chat, listener)
            except Exception as e:
                self.log('断句等待触发的投递失败：', repr(e))

    def release(self, chat):
        """放弃「已排 flush」的标记（投递失败时用）。消息仍留在待处理里。"""
        with self._guard:
            self._flush_queued.discard(chat or "_")

    def pending(self, chat):
        with self._guard:
            return len(self._pending.get(chat or "_", []))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                chats=len(self._pending),
                queued=sum(len(v) for v in self._pending.values()),
            )


class MessagePipeline:
    def __init__(self, workers=4, per_chat_limit=8, log=None, name="whale-decider",
                 drop_log_interval=10.0):
        self.workers = max(1, int(workers))
        self.per_chat_limit = max(1, int(per_chat_limit))
        self.drop_log_interval = max(0.0, float(drop_log_interval))
        self.log = log or (lambda *a: None)
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=name)
        self._guard = threading.Lock()
        self._queues = {}          # chat -> [(fn, args)]
        self._running = set()      # 正在被处理的会话
        self._closed = False
        # 积压日志节流：卡住时每条新消息都溢出一次，原样打印就是刷屏。
        self._drop_log_at = {}     # 有界的日志窗口记录，不作业务去重
        self._drop_count = {}      # chat -> 本窗口内已丢条数
        self.stats = {"in": 0, "done": 0, "dropped": 0, "errors": 0, "peak_queue": 0}

    def submit(self, chat, fn, *args):
        """投递一条任务。返回 False 表示已经 close。"""
        chat = chat or "_"
        with self._guard:
            if self._closed:
                return False
            self.stats["in"] += 1
            q = self._queues.setdefault(chat, [])
            q.append((fn, args))
            if len(q) > self.per_chat_limit:
                # 同一会话积压太多：丢最旧的。这是安全网 —— 正常情况下走不到：
                # engine 每个会话同时只排一个 flush 任务，消息本身由
                # MessageBatches 攒着，不占这里的队列额度。
                q.pop(0)
                self.stats["dropped"] += 1
                self._drop_count[chat] = self._drop_count.get(chat, 0) + 1

                def emit_drop():
                    n = self._drop_count.pop(chat, 1)
                    self.log("会话积压超过 %d 条，%.0f 秒内丢掉 %d 条：%s"
                             % (self.per_chat_limit, self.drop_log_interval, n, safe_id(chat)))
                bounded_log(self._drop_log_at, chat, ttl=self.drop_log_interval,
                            emit=emit_drop, clock=time.monotonic)
                # These are log counters only; business queues and deduplication
                # remain untouched when old log keys expire or are evicted.
                for old_chat in tuple(self._drop_count):
                    if old_chat not in self._drop_log_at:
                        self._drop_count.pop(old_chat, None)
            if len(q) > self.stats["peak_queue"]:
                self.stats["peak_queue"] = len(q)
            if chat in self._running:
                return True
            self._running.add(chat)
        # submit 保持在锁外（收进锁内会让 drain 线程晚一步拿到锁、队首被积压上限
        # 挤掉），改用 try/except 挡住与 close() 的竞态（L7）：close() 把 _closed
        # 置真后才 shutdown 线程池，这里撞上「已经关池」时不能把 RuntimeError
        # 抛给消息线程（旧实现会话会永久卡死），而是清掉本会话痕迹、按「已关闭」
        # 语义返回 False。
        try:
            self._pool.submit(self._drain, chat)
        except RuntimeError:
            with self._guard:
                self._running.discard(chat)
                self._queues.pop(chat, None)
                self._closed = True
            self.log("消息调度已关闭，这条没能排上：", safe_id(chat))
            return False
        return True

    def _drain(self, chat):
        while True:
            with self._guard:
                q = self._queues.get(chat)
                if not q:
                    self._running.discard(chat)
                    self._queues.pop(chat, None)
                    return
                fn, args = q.pop(0)
            try:
                fn(*args)
                with self._guard:
                    self.stats["done"] += 1
            except Exception as e:                 # noqa: BLE001
                with self._guard:
                    self.stats["errors"] += 1
                self.log("处理消息异常：", repr(e))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                running=len(self._running),
                queued=sum(len(v) for v in self._queues.values()),
                workers=self.workers,
            )

    def close(self, wait=True):
        with self._guard:
            self._closed = True
        self._pool.shutdown(wait=wait)
