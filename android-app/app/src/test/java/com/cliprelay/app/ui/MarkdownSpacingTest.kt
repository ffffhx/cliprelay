package com.cliprelay.app.ui

import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.MarkdownParser
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownSpacingTest {
    private fun gaps(source: String): List<Boolean> {
        val root = MarkdownParser(GFMFlavourDescriptor()).buildMarkdownTreeFromString(source)
        fun paragraphs(node: ASTNode): List<ASTNode> =
            if (node.type == MarkdownElementTypes.PARAGRAPH) listOf(node) else node.children.flatMap { paragraphs(it) }
        return paragraphs(root).map { needsParagraphGap(source, it) }
    }

    @Test fun distinguishesParagraphsAndListSpacing() {
        assertEquals(listOf(true, true), gaps("正文\n段内换行\n\n另一段"))
        assertEquals(listOf(false, false), gaps("- 第一项\n- 第二项"))
        assertEquals(listOf(true, true), gaps("- 第一项\n\n- 第二项"))
        assertEquals(listOf(false, false), gaps("1. 第一项\n2. 第二项"))
        assertEquals(listOf(true, true, true), gaps("- 第一项\n\n  项内第二段\n- 第二项"))
        assertEquals(listOf(false, true, true, false), gaps("- 外层一\n  - 内层一\n\n  - 内层二\n- 外层二"))
        assertEquals(listOf(false, true), gaps("- 第一项\n\n尾段"))
        assertEquals(listOf(false, false), gaps("- 第一项\n  ```\n  a\n\n  b\n  ```\n- 第二项"))
    }
}
