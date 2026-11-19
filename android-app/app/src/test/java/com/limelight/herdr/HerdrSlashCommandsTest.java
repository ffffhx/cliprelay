package com.limelight.herdr;

import org.junit.Test;
import java.util.List;
import java.util.Locale;
import static org.junit.Assert.*;

public class HerdrSlashCommandsTest {
    @Test public void permissionsPrefixFindsThePermissionPicker() {
        List<HerdrSlashCommands.Command> matches = HerdrSlashCommands.matching("codex", "/per");
        assertEquals(1, matches.size());
        assertEquals("/permissions", matches.get(0).text);
        assertEquals("切换权限与审批方式", matches.get(0).description);
    }

    @Test public void slashAndSharedPrefixesOfferAllMatchesInOrder() {
        assertTrue(HerdrSlashCommands.matching("codex", "/").size() > 3);
        List<HerdrSlashCommands.Command> matches = HerdrSlashCommands.matching("codex", "/p");
        assertEquals(2, matches.size());
        assertEquals("/permissions", matches.get(0).text);
        assertEquals("/plan", matches.get(1).text);
        assertEquals("/model", HerdrSlashCommands.matching("codex", "/mo").get(0).text);
    }

    @Test public void completedCommandsAndArgumentsDoNotReopenThePicker() {
        for (String draft : new String[]{"/permissions", "/model", "/permissions ",
                "/permissions :workspace", "/plan fix this", "/model gpt-example"}) {
            assertTrue(draft, HerdrSlashCommands.matching("codex", draft).isEmpty());
        }
    }

    @Test public void prosePathsMultilineAndUnknownCommandsAreNotRewritten() {
        for (String draft : new String[]{"", "per", " /per", "请解释 /per", "/tmp/file", "/per\n",
                "/per\t", "/per\r", "/自定义", "/my-custom-command", "//per"}) {
            assertTrue(draft, HerdrSlashCommands.matching("codex", draft).isEmpty());
        }
        assertTrue(HerdrSlashCommands.matching("codex", null).isEmpty());
    }

    @Test public void suggestionsBelongOnlyToTheSelectedCodexSession() {
        for (String agent : new String[]{"", "claude", "gemini", "cli-custom", "shell", null}) {
            assertTrue(HerdrSlashCommands.matching(agent, "/per").isEmpty());
        }
    }

    @Test public void phoneCapitalizationDoesNotDependOnSystemLocale() {
        Locale before = Locale.getDefault();
        try {
            Locale.setDefault(new Locale("tr", "TR"));
            assertEquals("/permissions", HerdrSlashCommands.matching("codex", "/PERMI").get(0).text);
        } finally { Locale.setDefault(before); }
    }
}
