'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { parsePage } = require('./links');

// 外部网页格式不受控，解析放在可终止的线程中，避免拖住整个消息事件循环。
parentPort.postMessage(parsePage(workerData.html, workerData.url));
