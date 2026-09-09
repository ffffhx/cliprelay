# Markdown 预览验收

正文支持 **加粗**、*斜体*、~~删除线~~ 和 `git revert` 行内代码。

## 操作步骤

1. 点击网页的复制按钮。
2. 按 Ctrl+C 发送 Markdown 原文。
3. 在手机上打开全屏预览。

> 引用：复制全文仍保留原始 Markdown 标记。

## 代码与横向滚动

```kotlin
fun greet(name: String): String {
    // 中文注释与缩进应保留
    val message = "Hello, $name! This is a deliberately long line to check horizontal scrolling without switching the history page."
    return message
}
```

## 表格

| 功能 | 预期效果 | 验证 |
| --- | --- | --- |
| 标题 | 分级字号 | 清晰 |
| 代码 | 高亮、横向滚动 | 保留缩进 |
| 原文 | Markdown 标记 | 可复制 |

- 普通列表
  - 嵌套列表
- [x] 保留原文
- [ ] 继续阅读

[ClipRelay 项目](https://github.com/ffffhx/cliprelay)

---

预览结束。横竖屏切换和字号调整后，内容应完整可读。
