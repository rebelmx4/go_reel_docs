```json
{
  "path_settings": {
    "source_folder": "D:/m/影片",
    "edited_output_folder": "D:/m/被剪辑",
    "pending_delete_folder": "D:/m/待删除",
    "export_dir": "D:/m/截图"
  },

  "playback_state": {
    "order_mode": "recent",
    "order_mode_comment": "播放顺序模式。可选值: 'random' (随机) 或 'recent' (最近创建优先)",

    "play_type": "normal",
    "play_type_comment": "播放类型。可选值: 'normal' (正常播放) 或 'skip' (跳帧播放)",

    "step_unit": "second",
    "step_unit_comment": "步进单位。可选值: 'frame' (帧) 或 'second' (秒)",

    "volume": 75,
    "comment": "音量大小 0-100"
  },


  "skip_frame_settings": {
    "hold_time_sec": 2,
    "comment": "跳帧模式下，每个时间点停留的秒数，默认2秒",

    "rules": {
      "30s": 0,
      "1m": 5,
      "10m": 20,
      "60m": 40,
      "120m": 60,
      "10000m": 60
    },
    "rule_comment": "Key代表时长上限(小于等于)。Value代表分段数。0表示不分段(正常播放)。"
  }
}
```



##### skip_frame / rules

**逻辑规则：**

1. 将 skip_frame 的所有 Key 转换为统一的时间单位（例如秒）。
2. 将这些 Key 按时间从小到大排序。
3. 获取当前视频的总时长 duration。
4. 遍历排序后的 Key，找到**第一个等于** duration 的 Key。
5. 该 Key 对应的 Value 就是分段数量。

**具体示例分析：**

| 视频时长范围 (Duration)        | 匹配到的 Key | 分段数量 (Value) | 播放行为语义                    |
  | ------------------------------ | ------------ | ---------------- | ------------------------------- |
  | **0 < 时长 ≤ 30秒**            | 30s          | **0**            | **全片播放** (不跳帧，视为短片) |
  | **30秒 < 时长 ≤ 1分钟**        | 1m           | **5**            | 整个视频切 5 个时间点播放       |
  | **1分钟 < 时长 ≤ 10分钟**      | 10m          | **20**           | 整个视频切 20 个时间点播放      |
  | **10分钟 < 时长 ≤ 60分钟**     | 60m          | **40**           | 整个视频切 40 个时间点播放      |
  | **60分钟 < 时长 ≤ 120分钟**    | 120m         | **60**           | 整个视频切 60 个时间点播放      |
  | **120分钟 < 时长 ≤ 10000分钟** | 10000m       | **60**           | 整个视频切 60 个时间点播放      |