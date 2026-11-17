'use strict';

// 保留原公共入口，调用方不必跟随内部拆分修改导入路径。
const prompt = require('./prompt');
const expression = require('./expression');

module.exports = {
  ...prompt,
  ...require('./messageText'),
  ...require('./demo'),
  emojiChanceFor: expression.emojiChanceFor,
  kaomojiPick: expression.kaomojiPick,
  KAOMOJI: expression.KAOMOJI,
  EMOJI_LEVEL_CHANCE: expression.EMOJI_LEVEL_CHANCE,
};
