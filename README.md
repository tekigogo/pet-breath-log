# 呼吸记录（pet-breath-log）

记录宠物熟睡时的呼吸次数（SRR）。家人共享、实时同步、看趋势。iPhone 优先，装到主屏幕使用。

**这是记录工具，不是医疗器械，不能诊断。** 警戒值请按兽医的意见设置。

## 功能

- 30 秒 / 60 秒点按计数，或手动输入；计时结束有提示音和闪屏
- 家人各自登录，记录实时出现在对方手机上，并标出是谁记录的
- 三档颜色：低于黄线（绿）、黄线到红线（黄）、高于红线（红）；颜色之外都有文字
- 「熟睡 / 醒着」字段：只有熟睡的记录参与警戒判断
- 趋势图：7 / 14 / 90 天 / 全部；不同家人用不同形状；用药、就诊等事件画成竖线
- 连续 2 次高于红线时显示联系医院的提示和一句日语说明
- 没有网络时先存本机，联网后自动同步
- 分享最近 7 天摘要；CSV 导出、导入
- Siri 语音记录（快捷指令），见 [docs/siri-shortcut.md](docs/siri-shortcut.md)

## 结构

纯静态网页，没有构建步骤：

| 文件 | 作用 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 页面和交互 |
| `data.js` | 数据层（Supabase 适配器 + 本地测试用的 mock）。以后换后端只改这里 |
| `config.js` | 后端地址和公开密钥 |
| `sw.js` / `manifest.webmanifest` | 离线缓存和主屏幕安装 |
| `vendor/supabase.js` | supabase-js 浏览器版（本地打包，不依赖外部 CDN） |
| `supabase/schema.sql` | 数据库表、权限规则（RLS）、函数 |
| `supabase/functions/siri-record` | Siri 快捷指令用的接口 |

本地测试：`python3 -m http.server`，打开 `index.html?mock=1`（假数据，不连后端）。

## 安全

- 公开密钥（publishable key）可以公开。数据访问由数据库的行级权限（RLS）控制：只有同一个家庭的成员能读写。
- Siri 令牌只存 SHA-256 哈希，可以随时在设置里删除。

## 许可

暂未决定。
