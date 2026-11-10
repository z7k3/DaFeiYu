# -*- coding: utf-8 -*-
"""桥接单实例锁：占一个本地 TCP 端口；占不到的时候要分清「已有实例」和「端口被系统保留」。

背景（2026-11 本机实测）：
  C:\\Users\\<你>\\.wslconfig 里写了 networkingMode=mirrored 时，WSL2 会把 Linux
  虚拟机的临时端口段整段保留在 Windows 宿主机上。实测虚拟机的
  /proc/sys/net/ipv4/ip_local_port_range = 44620 48715，宿主机上同一段
  44620-48715 的 TCP/UDP bind() 全部失败。表现很坑：

    * bind() 抛 WSAEADDRINUSE(10048)，加上 SO_REUSEADDR 则抛 WSAEACCES(10013)；
    * netstat -ano 里看不到任何占用者，netsh int ipv4 show excludedportrange 也不列；
    * 于是「真的已有桥接在跑」和「这个端口根本不让绑」的报错长得一模一样。

  原来的代码把两种情况都当成「已有实例」，直接 return 0 秒退；启动器看到进程秒退、
  心跳为 0，就判定桥接离线并无限重启——日志里反复刷同一句「已经有一个桥接在跑了」，
  真正的原因（端口被保留）反而被盖掉了。

所以这里做三分法：
  status='ok'      抢到锁，sock 一直持有到进程结束
  status='running' 端口被占、而且连得上 → 真的已有实例，调用方正常退出
  status='blocked' 候选端口全部绑不上、也全部连不上 → 系统保留/被拦截，调用方报错并非 0 退出
"""

import socket

# 候选锁端口：按顺序抢，第一个绑得上的就是锁。
# 这个列表必须固定且顺序一致，否则两个实例可能各绑一个，谁都拦不住谁。
# 不要再放回 47821：它落在 WSL2 保留的 44620-48715 里。
DEFAULT_LOCK_PORTS = (48800, 48810, 48820)

# 判断「那个端口上是不是真有人听着」的超时：本机回环，0.4 秒足够。
CONNECT_TIMEOUT = 0.4


def _try_bind(port):
    """能绑返回 (sock, None)；不能绑返回 (None, OSError)。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # SO_REUSEADDR 显式关掉：Windows 上开着它 bind 会去「抢」别人已经绑上的端口，
        # 单实例锁就失效了。
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        sock.bind(('127.0.0.1', port))
        sock.listen(1)
        return sock, None
    except OSError as e:
        try:
            sock.close()
        except Exception:
            pass
        return None, e


def _connectable(port):
    """能连上说明真的有一个实例在这个端口上听着。"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(CONNECT_TIMEOUT)
    try:
        sock.connect(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass


def acquire(ports=None):
    """按顺序抢锁。

    返回 dict：
      status  'ok' / 'running' / 'blocked'
      port    拿到/冲突的端口（blocked 时为 None）
      sock    拿到锁时的监听套接字（调用方必须持有）
      error   最后一次 bind 的 OSError
      tried   [(port, OSError, 连得上吗), ...]，打日志用
    """
    ports = tuple(ports) if ports else DEFAULT_LOCK_PORTS
    tried = []
    for port in ports:
        sock, err = _try_bind(port)
        if sock is not None:
            return {'status': 'ok', 'port': port, 'sock': sock, 'error': None, 'tried': tried}
        alive = _connectable(port)
        tried.append((port, err, alive))
        if alive:
            return {'status': 'running', 'port': port, 'sock': None, 'error': err, 'tried': tried}
    return {
        'status': 'blocked',
        'port': None,
        'sock': None,
        'error': tried[-1][1] if tried else None,
        'tried': tried,
    }


def describe(state):
    """把 acquire() 的结果压成一行，给日志用。"""
    if state.get('status') == 'running':
        return '已有实例（端口 %s 能连上）' % state.get('port')
    if state.get('status') == 'ok':
        return '锁已获取（端口 %s）' % state.get('port')
    parts = []
    for port, err, alive in state.get('tried') or []:
        parts.append('%s: bind 失败%s%s' % (port, ('（%s）' % err) if err else '', '，但连得上' if alive else '，也连不上'))
    return '；'.join(parts) or '没有可用的候选端口'
