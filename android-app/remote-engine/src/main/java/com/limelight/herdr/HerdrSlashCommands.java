package com.limelight.herdr;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/** Local suggestions for common Codex CLI commands, not a remote capability list.
 * https://learn.chatgpt.com/docs/developer-commands?surface=cli
 * Unknown commands and arguments remain ordinary drafts and can still be sent.
 */
final class HerdrSlashCommands {
    static final class Command {
        final String text, description;
        Command(String text, String description) {
            this.text = text;
            this.description = description;
        }
    }

    private static final Command[] CODEX = {
        new Command("/permissions", "切换权限与审批方式"),
        new Command("/model", "选择模型与推理强度"),
        new Command("/plan", "切换计划模式"),
        new Command("/status", "查看当前会话设置与用量"),
        new Command("/review", "检查代码改动"),
        new Command("/diff", "查看工作区差异"),
        new Command("/compact", "压缩当前对话上下文"),
        new Command("/resume", "恢复已有会话"),
        new Command("/new", "开始新对话"),
        new Command("/skills", "查看可用技能"),
        new Command("/mcp", "查看已配置的 MCP 工具")
    };

    static List<Command> matching(String agent, String draft) {
        // Never replace arguments, prose, multiline text, or another agent's input.
        if (!"codex".equals(agent) || draft == null || !draft.matches("/[a-zA-Z]*")) {
            return Collections.emptyList();
        }
        for (Command command : CODEX) {
            if (command.text.equals(draft)) return Collections.emptyList();
        }
        String prefix = draft.toLowerCase(Locale.ROOT);
        List<Command> matches = new ArrayList<>();
        for (Command command : CODEX) {
            if (command.text.startsWith(prefix)) matches.add(command);
        }
        return matches;
    }

    private HerdrSlashCommands() {}
}
