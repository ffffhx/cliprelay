package com.limelight.herdr;

import org.junit.Test;
import static org.junit.Assert.*;

public class HerdrTerminalFormatterTest {
    @Test public void joinsDesktopProseWrapsButKeepsParagraphsAndBullets(){
        String paragraph="• "+"连续中文".repeat(4)+"表示在普";
        String list="  • "+"这是列表内容".repeat(3);
        String source=paragraph+"\n  通终端里显示界面。\n\n"+list+"\n    这还是同一个条目。\n  • 第二个条目。\n\n  短行一\n  短行二";
        String text=HerdrTerminalFormatter.format(source,0,-1,42).text.toString();
        assertTrue(text.contains("表示在普通终端里显示界面。"));
        assertTrue(text.contains("这是列表内容这还是同一个条目。\n• 第二个条目。"));
        assertTrue(text.contains("\n\n"));assertTrue(text.contains("短行一\n短行二"));
    }
    @Test public void preservesCodeTablesAndCharacterArt(){
        String code="    const message = '"+"a".repeat(60)+"';\n    return message;";
        String table="  │ Name | Value │\n  │ A    | B     │";
        String art="⣀⣤⣤⣿⣿⣤".repeat(8)+"\n"+"⣤⣤⣿⣿⣤⣀".repeat(8);
        String json="  \"value\": \""+"a".repeat(60)+"\",\n  \"next\": 42";
        String assignment="  message = '"+"a".repeat(60)+"'\n  result = message";
        String text=HerdrTerminalFormatter.format(code+"\n\n"+table+"\n\n"+art+"\n\n"+json+"\n\n"+assignment,0,-1,40).text.toString();
        assertTrue(text.contains(code));assertTrue(text.contains(table));assertTrue(text.contains(art));assertTrue(text.contains(json));assertTrue(text.contains(assignment));
    }
    @Test public void removesOnlyActiveFooterAndRetainsPathsInContent(){
        String body="• 项目目录是 C:\\work\\project。\n  GPT-6-Astra xhigh · ~\\work\\example\n\n";
        String footer="\n  GPT-6-Astra xhigh · ~\\work\\actual · Test ·…";
        var result=HerdrTerminalFormatter.format(body+footer,body.length(),body.length(),95);
        assertEquals("GPT-6-Astra xhigh",result.model);assertTrue(result.text.toString().contains("C:\\work\\project"));
        assertTrue(result.text.toString().contains("~\\work\\example"));assertFalse(result.text.toString().contains("~\\work\\actual"));
        assertEquals(result.text.length(),result.cursor);
        assertNull(HerdrTerminalFormatter.format(body+footer,0,-1,95).model);
    }
    @Test public void mappedCharactersKeepTheirOriginalContent(){
        String source="• "+"连续中文".repeat(6)+"\n  后续正文\n\n  • 下一条";
        var result=HerdrTerminalFormatter.format(source,0,-1,50);
        for(var slice:result.slices)assertEquals(source.substring(slice.from,slice.to),result.text.substring(slice.target,slice.target+slice.to-slice.from));
    }
    @Test public void joinsWrappedToolDescriptionsWithoutJoiningToolCode(){
        String description="  └ Resume a previous interactive session (picker by default; use --last to continue the most\n    recent)";
        String code="  └ const message = '"+"a".repeat(72)+"';\n    return message;";
        String text=HerdrTerminalFormatter.format(description+"\n\n"+code,0,-1,95).text.toString();
        assertTrue(text.contains("most recent)"));assertTrue(text.contains(code));
    }
    @Test public void cursorOnTrailingBlankStillFollowsLatestOutput(){
        String source="old output\nlatest output\n \n\n";
        var result=HerdrTerminalFormatter.format(source,source.length()-3,-1,80);
        assertEquals("old output\nlatest output",result.text.toString());assertEquals(result.text.length(),result.cursor);
    }
    @Test public void narrowDesktopWrapsDoNotSplitChineseWordsOrCommandFlags(){
        String source="• 最上面那段的意思是：终端与这个 Codex 任务断\n  开了连接，但正在运行的工作会继续。 这条提示\n  本身不代表任务报错。\n\n"+
            "  下面已经出现了你执行 codex resume ... --no-\n  alt-screen 后的启动画面。";
        String text=HerdrTerminalFormatter.format(source,0,-1,45).text.toString();
        assertTrue(text.contains("任务断开了连接"));assertTrue(text.contains("这条提示本身"));assertTrue(text.contains("--no-alt-screen"));
    }
    @Test public void toolStylesDoNotLeakIntoMessagesAndNestedBullets(){
        String source="• Ran check\n  └ ok\n• 正常回复\n    - 子条目\n› 用户的问题\n\n    const value = 1;";
        var result=HerdrTerminalFormatter.format(source,0,-1,80);
        for(var p:result.paragraphs){String line=result.text.substring(p.start,Math.min(p.end,result.text.length()));
            if(line.contains("正常回复")||line.contains("子条目")||line.contains("用户的问题"))assertFalse(line,p.code);
            if(line.contains("const value"))assertTrue(line,p.code);
        }
        assertTrue(result.text.toString().contains("正常回复\n- 子条目\n› 用户的问题"));
    }
}
